import { PrismaClient } from "@prisma/client";
import { connect } from "amqplib";
import { getMessageHandler } from "./handler";
import { pino } from "pino";

(async () => {
  const prisma = new PrismaClient();

  const logger = pino();

  const queue = "transactions";

  const AMQP_URL = process.env.AMQP_URL ?? "amqp://guest:guest@localhost:5672";

  const connection = await connect(AMQP_URL);
  logger.info("Connected to RabbitMQ");

  const channel = await connection.createChannel();

  await channel.assertQueue(queue);

  // We seperate the handler function from the `consume` loop so we can write
  // unite tests just for the handler.
  const handler = getMessageHandler(channel, prisma);

  channel.consume(queue, handler);
})();
