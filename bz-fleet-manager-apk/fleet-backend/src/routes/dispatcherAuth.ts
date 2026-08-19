import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword } from "../lib/password.js";
import { signDispatcherAccess, signDispatcherRefresh } from "../lib/tokens.js";
import { validateBody } from "../middleware/validate.js";

// Mounted at "/api/auth" — sibling of authRouter's "/driver/login", giving
// "/api/auth/dispatcher/login". Refresh/logout are NOT duplicated here: the
// shared "/api/auth/refresh" and "/api/auth/logout" routes already branch on
// the token payload's role.
export const dispatcherAuthRouter = Router();
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

dispatcherAuthRouter.post("/dispatcher/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  const dispatcher = await prisma.dispatcher.findUnique({ where: { email } });
  if (!dispatcher || !(await verifyPassword(password, dispatcher.passwordHash)))
    return res.status(401).json({ error: "Invalid email or password" });
  const { passwordHash, ...safe } = dispatcher;
  const refresh = signDispatcherRefresh(dispatcher.id);
  res.json({ dispatcher: safe, token: signDispatcherAccess(dispatcher.id), refreshToken: refresh.token });
});
