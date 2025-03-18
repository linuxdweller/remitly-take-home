import { expect, test as base, onTestFinished, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Channel, connect, ConsumeMessage, GetMessage } from "amqplib";
import { getMessageHandler } from "../src/handler";
import { createUser } from "./utils";
import { Decimal } from "@prisma/client/runtime/library";

// Use a different queue name from the actual apps' queue name.
// If we use the same queue as the one the actual app use,
// the app will consume it before out tests will.
const queue = "test";

const test = base.extend<{
  prismaClient: PrismaClient;
  channel: Channel;
}>({
  async prismaClient({}, use) {
    const client = new PrismaClient();

    await use(client);

    // Delete all rows after each test.
    client.transactions.deleteMany({ where: {} });
  },
  async channel({}, use) {
    const url = "amqp://guest:guest@localhost:5672";

    const conn = await connect(url);

    const channel = await conn.createChannel();

    channel.assertQueue(queue);

    use(channel);

    channel.ackAll();
  },
});

test("A message with a valid transaction", async ({
  channel,
  prismaClient,
}) => {
  // Cleenup all existing users, transactions and messages
  // as they can cause errors during the test.
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

  const handler = getMessageHandler(channel, prismaClient);

  const messageId = crypto.randomUUID();

  const message = {
    messageId,
    from: sender.id,
    to: receiver.id,
    ammount: 1000,
  };

  channel.assertQueue(queue);

  channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));

  const messageReceived = await channel.get(queue);

  expect(messageReceived).not.toBeFalsy();

  // Refactor this cast in the future.
  // Casting GetMessage to ConsumeMessage is ok for us
  // because it's almost the same type and we dont use the different
  // fields.
  await handler(messageReceived as unknown as ConsumeMessage);

  // Assert the handler removed the message from the queue
  // by checking it is now empty.
  expect(await channel.get(queue)).toBeFalsy();

  // transactions table was empty and now contains only the processed transaction
  // so just fetch the first row in the table.
  const transaction = await prismaClient.transactions.findFirst({});

  expect(transaction).not.toBeNull();

  expect(transaction?.amount).toEqual(new Decimal(1000));
  expect(transaction?.fromId).toEqual(sender.id);
  expect(transaction?.toId).toEqual(receiver.id);
  expect(transaction?.status).toEqual("accepted");

  const senderAfter = await prismaClient.users.findFirst({
    where: { id: sender.id },
  });

  expect(senderAfter).not.toBeNull();

  expect(senderAfter?.balance).toEqual(new Decimal(0));

  const receiverAfter = await prismaClient.users.findFirst({
    where: { id: receiver.id },
  });

  expect(receiverAfter).not.toBeNull();

  expect(receiverAfter?.balance).toEqual(new Decimal(2000));
});

test("A message with an invalid transaction - not enough funds", async ({
  channel,
  prismaClient,
}) => {
  // Cleenup all existing users, transactions and messages
  // as they can cause errors during the test.
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

  const handler = getMessageHandler(channel, prismaClient);

  const messageId = crypto.randomUUID();

  const message = {
    messageId,
    from: sender.id,
    to: receiver.id,
    // Sender has only 1000 funds, so sending 1500 should fail.
    ammount: 1500,
  };

  channel.assertQueue(queue);

  channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));

  const messageReceived = await channel.get(queue);

  expect(messageReceived).not.toBeFalsy();

  // Refactor this cast in the future.
  // Casting GetMessage to ConsumeMessage is ok for us
  // because it's almost the same type and we dont use the different
  // fields.
  await handler(messageReceived as unknown as ConsumeMessage);

  // Assert the handler removed the message from the queue
  // by checking it is now empty.
  expect(await channel.get(queue)).toBeFalsy();

  // transactions table was empty and now contains only the processed transaction
  // so just fetch the first row in the table.
  const transaction = await prismaClient.transactions.findFirst({});

  expect(transaction).not.toBeNull();

  expect(transaction?.amount).toEqual(new Decimal(1500));
  expect(transaction?.fromId).toEqual(sender.id);
  expect(transaction?.toId).toEqual(receiver.id);
  expect(transaction?.status).toEqual("rejected");

  // Check balance of both users did not change.
  const senderAfter = await prismaClient.users.findFirst({
    where: { id: sender.id },
  });

  expect(senderAfter).not.toBeNull();

  expect(senderAfter?.balance).toEqual(new Decimal(1000));

  const receiverAfter = await prismaClient.users.findFirst({
    where: { id: receiver.id },
  });

  expect(receiverAfter).not.toBeNull();

  expect(receiverAfter?.balance).toEqual(new Decimal(1000));
});

test("A message with an invalid transaction - fails Zod schema check", async ({
  channel,
  prismaClient,
}) => {
  // In case of a schema failure, we want to reject the
  // message and not record any transaction.

  // Cleenup all existing users, transactions and messages
  // as they can cause errors during the test.
  await prismaClient.users.deleteMany({});
  await prismaClient.transactions.deleteMany({});
  channel.ackAll();

  const handler = getMessageHandler(channel, prismaClient);

  const message = {
    // Schema fail as `messageId` is missing.
    messageId: undefined,
    // Schema fail as `from` should be a number.
    from: "a string",
    // Schema fail as `to` should be a number.
    to: {},
    // Schema fail as `ammount` should be a number.
    ammount: "",
  };

  channel.assertQueue(queue);

  channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));

  const messageReceived = await channel.get(queue);

  expect(messageReceived).not.toBeFalsy();

  await handler(messageReceived as unknown as ConsumeMessage);

  // Assert the handler removed the message from the queue
  // by checking it is now empty.
  expect(await channel.get(queue)).toBeFalsy();

  // transactions table was empty and now contains only the processed transaction
  // so just fetch the first row in the table.
  const transaction = await prismaClient.transactions.findFirst({});

  // No transaction should have been recorded on message
  // schema parsing failure.
  expect(transaction).toBeNull();
});

test("A message with an invalid transaction - sender user ID does not exist", async ({
  channel,
  prismaClient,
}) => {
  // If the sender ID does not exist, we dont want to record a transaction.

  // Cleenup all existing users, transactions and messages
  // as they can cause errors during the test.
  await prismaClient.users.deleteMany({});
  await prismaClient.transactions.deleteMany({});
  channel.ackAll();

  const receiver = await createUser(prismaClient, {
    email: "receiver@example.com",
    password: "example123",
  });

  const handler = getMessageHandler(channel, prismaClient);

  const messageId = crypto.randomUUID();

  const message = {
    messageId,
    from: -1,
    to: receiver.id,
    ammount: 1000,
  };

  channel.assertQueue(queue);

  channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));

  const messageReceived = await channel.get(queue);

  expect(messageReceived).not.toBeFalsy();

  // Refactor this cast in the future.
  // Casting GetMessage to ConsumeMessage is ok for us
  // because it's almost the same type and we dont use the different
  // fields.
  await handler(messageReceived as unknown as ConsumeMessage);

  // Assert the handler removed the message from the queue
  // by checking it is now empty.
  expect(await channel.get(queue)).toBeFalsy();

  // transactions table was empty and now contains only the processed transaction
  // so just fetch the first row in the table.
  const transaction = await prismaClient.transactions.findFirst({});

  expect(transaction).toBeNull();

  // Check balance of both receiver did not change by some sort
  // of crazy mistake.
  const receiverAfter = await prismaClient.users.findFirst({
    where: { id: receiver.id },
  });

  expect(receiverAfter).not.toBeNull();

  expect(receiverAfter?.balance).toEqual(new Decimal(1000));
});

test("A message with an invalid transaction - receiver user ID does not exist", async ({
  channel,
  prismaClient,
}) => {
  // If the sender ID does not exist, we dont want to record a transaction.

  // Cleenup all existing users, transactions and messages
  // as they can cause errors during the test.
  await prismaClient.users.deleteMany({});
  await prismaClient.transactions.deleteMany({});
  channel.ackAll();

  const sender = await createUser(prismaClient, {
    email: "sender@example.com",
    password: "example123",
  });

  const handler = getMessageHandler(channel, prismaClient);

  const messageId = crypto.randomUUID();

  const message = {
    messageId,
    from: sender.id,
    to: -1,
    ammount: 1000,
  };

  channel.assertQueue(queue);

  channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));

  const messageReceived = await channel.get(queue);

  expect(messageReceived).not.toBeFalsy();

  // Refactor this cast in the future.
  // Casting GetMessage to ConsumeMessage is ok for us
  // because it's almost the same type and we dont use the different
  // fields.
  await handler(messageReceived as unknown as ConsumeMessage);

  // Assert the handler removed the message from the queue
  // by checking it is now empty.
  expect(await channel.get(queue)).toBeFalsy();

  // transactions table was empty and now contains only the processed transaction
  // so just fetch the first row in the table.
  const transaction = await prismaClient.transactions.findFirst({});

  expect(transaction).toBeNull();

  // Check balance of both receiver did not change by some sort
  // of crazy mistake.
  const senderAfter = await prismaClient.users.findFirst({
    where: { id: sender.id },
  });

  expect(senderAfter).not.toBeNull();

  expect(senderAfter?.balance).toEqual(new Decimal(1000));
});
