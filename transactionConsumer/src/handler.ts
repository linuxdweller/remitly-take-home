import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { Channel, ConsumeMessage } from "amqplib";
import { exit } from "process";
import { Decimal } from "@prisma/client/runtime/library";
import { pino } from "pino";
import { error } from "console";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

const logger = pino();

const PROMETHEUS_EXPORTER_PORT = process.env.PROMETHEUS_EXPORTER_PORT ?? "9464";

const exporter = new PrometheusExporter({
  port: parseInt(PROMETHEUS_EXPORTER_PORT),
});

// Creates MeterProvider and installs the exporter as a MetricReader
const meterProvider = new MeterProvider({
  readers: [exporter],
});
const meter = meterProvider.getMeter("prometheus");

const messagesReceivedCounter = meter.createCounter("messages_received", {
  description: "Number of messages received",
});

// We seperate the handler function from the `channel.consume` loop so we can write
// unite tests just for the handler.
export const getMessageHandler = (channel: Channel, prisma: PrismaClient) => {
  return async (message: ConsumeMessage | null): Promise<void> => {
    if (message === null) {
      // Consumer is canceled by rabbitmq.
      exit(0);
    }
    messagesReceivedCounter.add(1);

    const messageParsed = JSON.parse(message.content.toString()) as {
      from: number;
      to: number;
      ammount: number;
      messageId: string;
    };

    // Assert message schema before processing.
    // We also assert the same schema in the sender side.
    try {
      z.strictObject({
        messageId: z.string().uuid(),
        from: z.number(),
        to: z.number(),
        ammount: z.number(),
      }).parse(messageParsed);
    } catch (err) {
      logger.error({ err }, "Failed parsing event payload. Rejecting event.");
      // Set `requeue` to false as we can not recover
      // from a schema failure error.
      channel.nack(message, undefined, false);

      return;
    }
    const { messageId } = messageParsed;
    logger.info(
      { messageId },
      "Successfully parsed payload. Acknowledging message.",
    );

    channel.ack(message);

    try {
      await prisma.$transaction(async (tx) => {
        const sender = await tx.users.update({
          data: {
            balance: {
              decrement: messageParsed.ammount,
            },
          },
          where: {
            id: messageParsed.from,
          },
        });

        if (sender.balance < new Decimal(0)) {
          throw new Error(
            `${messageParsed.from} doesn't have enough to send ${messageParsed.ammount}`,
          );
        }

        await tx.users.update({
          data: {
            balance: {
              increment: messageParsed.ammount,
            },
          },
          where: {
            id: messageParsed.to,
          },
        });

        await tx.transactions.create({
          data: {
            status: "accepted",
            amount: messageParsed.ammount,
            fromId: messageParsed.from,
            toId: messageParsed.to,
          },
        });

        logger.info({ messageId }, "Transaction accepted.");
      });
    } catch (err) {
      // Transaction failed.
      logger.error({ err }, "Failed applying transaction.");

      if ((err as Error)?.message?.includes("doesn't have enough to send")) {
        // Sender doesn't have enough funds. Record the failed transaction
        // as rejected.
        logger.info(
          { messageId },
          "Sender does not have sufficient funds. Recording failed transaction.",
        );
        await prisma.transactions.create({
          data: {
            status: "rejected",
            amount: messageParsed.ammount,
            fromId: messageParsed.from,
            toId: messageParsed.to,
          },
        });
      }
    }
  };
};
