import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";
export const validateBody = (schema: ZodSchema): RequestHandler => (req, res, next) => {
  const r = schema.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: "Invalid request", details: r.error.flatten() });
  req.body = r.data;
  next();
};
