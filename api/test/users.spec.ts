import { expect, test as base, onTestFinished } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Express } from "express";
import { Channel, connect } from "amqplib";
import { app as apiApp } from "../src/app";
import { readFileSync } from "fs";
import { verify } from "jsonwebtoken";
const request = require("supertest");

import { createToken, createUser } from "./utils";

const queue = "transactions";

const client = new PrismaClient();

const test = base.extend<{
  app: Express;
  prismaClient: PrismaClient;
  channel: Channel;
}>({
  async prismaClient({}, use) {
    await use(client);

    // Delete all rows after each test.
    // We do this inside tests as well but lets just be safe and do it
    // here as well.
    client.transactions.deleteMany({});
    client.users.deleteMany({});
  },
  //@ts-ignore
  async app({}, use) {
    const server = apiApp.listen(3002);

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

test("Auth Middleware - 403 if token is expired", async ({
  app,
  prismaClient,
}) => {
  await prismaClient.users.deleteMany({});

  const user = await createUser(prismaClient, {
    email: "friedman@example.com",
    password: "example123",
  });

  // Expires in 0 seconds which means it expires instantly.
  const { token } = await createToken({ userId: user.id, expiresIn: "0s" });

  const r = await request(app).post("/transactions").set({
    Authorization: token,
  });

  expect(r.status).toEqual(403);
  expect(r.body.error).toEqual("Invalid token");
});

test("Auth Middleware - 403 if token is invalid", async ({ app }) => {
  const r = await request(app).post("/transactions").set({
    Authorization: "not_a_real_jwt",
  });

  expect(r.status).toEqual(403);
  expect(r.body).toEqual({ error: "Invalid token" });
});

test("Auth Middleware - 403 if token is missing", async ({ app }) => {
  const r = await request(app).post("/transactions");

  expect(r.status).toEqual(403);
  expect(r.body).toEqual({
    error: "please set the Authorization header with a valid JWT",
  });
});

test("POST /users - can create a user", async ({ app, prismaClient }) => {
  await prismaClient.users.deleteMany({});

  const email = "friedman@example.com";

  const r = await request(app).post("/users").send({
    email,
    password: "friedman123",
  });

  expect(r.status).toEqual(201);

  const user = prismaClient.users.findFirst({ where: { email } });

  expect(user).not.toBeNull();
});

test("POST /users/login - can login", async ({ app, prismaClient }) => {
  await prismaClient.users.deleteMany({});

  const password = "friedman123";
  const email = "friedman@example.com";

  const user = await createUser(prismaClient, { email, password });

  const r = await request(app).post("/users/login").send({
    password,
    email,
  });

  expect(r.status).toEqual(201);

  const token = r.body.token;

  expect(token).toBeDefined();

  const privateKey = readFileSync("secret/id_ed25519");

  const decoded = verify(token, privateKey, { algorithms: ["HS512"] }) as {
    userId: number;
  };

  expect(decoded.userId).toEqual(user.id);
});
