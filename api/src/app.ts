import express, { Request, RequestHandler } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { connect } from "amqplib";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { createClient } from "redis";
import { verify, sign } from "jsonwebtoken";
import { readFileSync } from "fs";
import { pinoHttp } from "pino-http";
import bcrypt from "bcryptjs";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

const PROMETHEUS_EXPORTER_PORT = process.env.PROMETHEUS_EXPORTER_PORT ?? "9464";

const exporter = new PrometheusExporter({
  port: parseInt(PROMETHEUS_EXPORTER_PORT),
});

// Creates MeterProvider and installs the exporter as a MetricReader
const meterProvider = new MeterProvider({
  readers: [exporter],
});
const meter = meterProvider.getMeter("prometheus");

const transactionsReceivedCounter = meter.createCounter(
  "transactions_received",
  {
    description: "Number of transactions submitted",
  },
);

const messagesSentCounter = meter.createCounter("messages_sent", {
  description: "Number of message sent to queue",
});

const privateKey = readFileSync("./secret/id_ed25519");

const prisma = new PrismaClient();

const AMQP_URL = process.env.AMQP_URL ?? "amqp://guest:guest@localhost:5672";

const connection = connect(AMQP_URL);

const queue = process.env.QUEUE_NAME ?? "transactions";

export const app = express();

app.use(pinoHttp());

type AuthRequest = Request & { userId: number };

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";

const redisClient = createClient({ url: REDIS_URL });

const isClientConnected = redisClient.connect();

const rateLimitingMiddleware: RequestHandler = async (req, res, next) => {
  const ip = req.ip;

  if (!ip) {
    res.status(500).json({ error: "client disconnected" });
    return;
  }

  try {
    await redisClient.setNX(ip, "10");

    const remainingQuota = await redisClient.get(ip);

    // After 10 seconds, rate limiting quota should reset.
    // We do this by expiring the key.
    await redisClient.expire(ip, 10);

    if (parseInt(remainingQuota as string) < 1) {
      res.status(429).json({
        error:
          "please slow down the rate of your requests. max allowed rate is 10 requests per 10 seconds.",
      });
      return;
    }

    await redisClient.decrBy(ip, 1);

    res.setHeader("request-quota-left", remainingQuota as string);
  } catch (e) {
    req.log.error(e);
    res.status(500).json({ error: "could not compute client request quota" });
    return;
  }

  next();
};

const authMiddleware: RequestHandler = (req, res, next) => {
  const token = req.header("Authorization");

  if (!token) {
    res
      .status(403)
      .json({ error: "please set the Authorization header with a valid JWT" });
    return next();
  }

  try {
    const payload = verify(token, privateKey, { algorithms: ["HS512"] }) as {
      userId: number;
    };

    (req as AuthRequest).userId = payload.userId;
  } catch (e) {
    res.status(403).json({ error: "Invalid token" });
    return;
  }

  next();
};

app.use(express.json());
if (!process.env.TEST) {
  app.use(rateLimitingMiddleware);
}

app.get("/liveness", async (req, res) => {
  try {
    await isClientConnected;
    await redisClient.ping();
  } catch (e) {
    req.log.error(e);
    res.status(503);
    return;
  }

  res.json({ liveness: "ok" });
});

app.post("/transactions", authMiddleware, async (req, res) => {
  transactionsReceivedCounter.add(1);

  const userId = (req as AuthRequest).userId;

  await z
    .strictObject({
      ammount: z.number().refine((num) => {
        // Only allow up to 8 digits after decimal point and
        // 24 before the decimal point.
        const numStr = num.toString().split(".");

        const digitsAfterDecimalPoint = numStr[1];

        if (digitsAfterDecimalPoint && digitsAfterDecimalPoint.length > 8) {
          return false;
        }

        const digitsBeforeDecimalPoint = numStr[0];

        if (digitsBeforeDecimalPoint && digitsBeforeDecimalPoint.length > 24) {
          return false;
        }

        return true;
      }),
      to: z.number().refine(async (userId) => {
        try {
          await prisma.users.findFirstOrThrow({ where: { id: userId } });

          return true;
        } catch (e) {
          return false;
        }
      }),
    })
    .parseAsync(req.body);

  const { ammount, to } = req.body as {
    ammount: number;
    to: number;
  };

  try {
    const conn = await connection;

    const channel = await conn.createChannel();

    const messageId = crypto.randomUUID();

    const message = {
      messageId,
      from: userId,
      to,
      ammount,
    };

    channel.assertQueue(queue);

    // Assert message schema before sending.
    // We also assert the same schema in the consumer side.
    z.strictObject({
      messageId: z.string().uuid(),
      from: z.number(),
      to: z.number(),
      ammount: z.number(),
    }).parse(message);

    messagesSentCounter.add(1);
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));

    req.log.info(`Sent message with ID ${message.messageId}`);

    res.status(201).json({ status: "submitted" });
  } catch (e) {
    // todo: add error handling.
    res.status(500).json({ error: "???" });
  }
});

app.post("/users", async (req, res) => {
  z.strictObject({
    email: z.string().email().max(255),
    password: z
      .string()
      .min(8)
      .refine(
        (password) => !bcrypt.truncates(password),
        "Password is too long.",
      ),
  }).parse(req.body);

  const { email, password } = req.body as { email: string; password: string };

  const hashedPassword = bcrypt.hashSync(password);

  const balance = 1000;

  try {
    const { id } = await prisma.users.create({
      data: {
        email,
        password: hashedPassword,
        // New users start with a balanace of 1000.
        // Otherwise, no user will be able to make a transaction.
        balance,
      },
    });

    res.status(201).json({ balance, userId: id });
  } catch (e) {
    req.log.error(e);
    if (e instanceof PrismaClientKnownRequestError) {
      res.status(400).json({ error: e.message });
      return;
    } else {
      // Rethrow and let express error middleware try and handle it.
      throw e;
    }
  }
});

app.post("/users/login", async (req, res) => {
  z.strictObject({
    email: z.string().email(),
    password: z.string(),
  }).parse(req.body);

  const { email, password } = req.body as {
    email: string;
    password: string;
  };

  const user = await prisma.users.findFirst({
    where: {
      email,
    },
  });

  if (user === null) {
    res.status(400).json({ error: "email and password are inccorect" });
    return;
  }

  const hashedPassword = user.password;

  const isPasswordCorrect = await bcrypt.compare(password, hashedPassword);

  if (!isPasswordCorrect) {
    res.status(400).json({ error: "email and password are inccorect" });
    return;
  }

  const token = sign({ userId: user.id }, privateKey, {
    algorithm: "HS512",
    expiresIn: "1h",
  });

  res.status(201).json({ token });
});

app.get("/transactions", authMiddleware, async (req, res) => {
  const userId = (req as AuthRequest).userId;

  const transactions = await prisma.transactions.findMany({
    where: {
      OR: [{ toId: userId }, { fromId: userId }],
    },
  });

  res.status(200).json({ transactions });
});
