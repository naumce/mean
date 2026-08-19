import request from "supertest";
import { createApp } from "../src/app.js";

it("GET /health returns ok", async () => {
  const res = await request(createApp()).get("/health");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: "ok" });
});
