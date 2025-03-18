import { expect, test as base, onTestFinished } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Express } from "express";
import { Channel, connect, GetMessage } from "amqplib";
import { app as apiApp } from "../src/app";
import { createToken, createUser } from "./utils";
const request = require("supertest");

const queue = "test";

const test = base.extend<{
  app: Express;
  prismaClient: PrismaClient;
  channel: Channel;
}>({
  async prismaClient({}, use) {
    const client = new PrismaClient();

    await use(client);
  },
  //@ts-ignore
  async app({}, use) {
    const server = apiApp.listen(3001);

    await use(server);

    server.close();
  },
  async channel({}, use) {
    const url = "amqp://guest:guest@localhost:5672";

    const conn = await connect(url);

    const channel = await conn.createChannel();

    channel.assertQueue(queue);

    use(channel);
  },
});

test("Health check", async ({ app }) => {
  const r = await request(app).get("/liveness");

  expect(r.status).toEqual(200);
});

test("POST /transactions", async ({ app, prismaClient, channel }) => {
  await prismaClient.users.deleteMany({});
  await prismaClient.transactions.deleteMany({});
  channel.ackAll();

  const sender = await createUser(prismaClient, {
    email: "sender@example.com",
    password: "example123",
  });

  const receiver = await createUser(prismaClient, {
    email: "receiver@example.com",
    password: "example123",
  });

  const { token } = await createToken({ userId: sender.id });

  const r = await request(app)
    .post("/transactions")
    .send({
      ammount: 1000,
      to: receiver.id,
    })
    .set({
      Authorization: token,
    });

  expect(r.status).toEqual(201);

  const message = await channel.get(queue);

  expect(message).not.toBeFalsy();

  channel.ack(message as GetMessage);

  const content = (message as GetMessage).content;

  const messageParsed = JSON.parse(content.toString()) as {
    from: number;
    to: number;
    ammount: number;
    messageId: string;
  };

  expect(messageParsed.ammount).toEqual(1000);
  expect(messageParsed.from).toEqual(sender.id);
  expect(messageParsed.to).toEqual(receiver.id);
  expect(messageParsed.messageId).toBeDefined();
});

test("GET /transactions", async ({ app, prismaClient }) => {
  await prismaClient.users.deleteMany({});
  await prismaClient.transactions.deleteMany({});

  const from = await createUser(prismaClient, {
    email: "from@example.com",
    password: "example123",
  });

  const to = await createUser(prismaClient, {
    email: "to@example.com",
    password: "example123",
  });

  // Create a transaction from `other` to `to` and
  // check it is not included in the response
  // when fetching transactions which `from` is involved in.
  const other = await createUser(prismaClient, {
    email: "other@example.com",
    password: "example123",
  });

  const { token } = await createToken({ userId: from.id });

  const createResult = await prismaClient.transactions.createMany({
    data: [
      // `from` -> `to`. Should be included in the response.
      {
        fromId: from.id,
        toId: to.id,
        amount: 1000,
        status: "accepted",
      },
      // `other` -> `to`. Should _not_ be included in the response.
      {
        fromId: other.id,
        toId: to.id,
        amount: 1000,
        status: "accepted",
      },
    ],
  });

  const r = await request(app).get("/transactions").set({
    Authorization: token,
  });

  expect(r.status).toEqual(200);

  // Only one out of the two transactions should be returned.
  expect(r.body.transactions).toHaveLength(1);

  expect(r.body.transactions[0].fromId).toEqual(from.id);
  expect(r.body.transactions[0].toId).toEqual(to.id);
  expect(r.body.transactions[0].amount).toEqual("1000");
});
