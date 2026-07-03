import NextAuth, { CredentialsSignin } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { z } from "zod";
import { checkRateLimit, getClientIp } from "./rate-limit";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const RATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Error específico de límite de intentos: el `code` viaja al cliente en la
 * respuesta de signIn() para que la página de login muestre un mensaje de
 * "demasiados intentos" en lugar del genérico de credenciales.
 */
class RateLimitError extends CredentialsSignin {
  code = "rate_limit";
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        // Límite de intentos por correo normalizado y por IP. Al excederse se
        // lanza RateLimitError para que el cliente distinga el caso.
        const emailKey = parsed.data.email.toLowerCase().trim();
        const emailLimit = checkRateLimit(`login:email:${emailKey}`, {
          limit: 10,
          windowMs: RATE_WINDOW_MS,
        });
        if (!emailLimit.ok) throw new RateLimitError();

        if (request instanceof Request) {
          const ipLimit = checkRateLimit(`login:ip:${getClientIp(request)}`, {
            limit: 20,
            windowMs: RATE_WINDOW_MS,
          });
          if (!ipLimit.ok) throw new RateLimitError();
        }

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });

        if (!user || !user.password) return null;

        const passwordOk = await bcrypt.compare(parsed.data.password, user.password);
        if (!passwordOk) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.id) session.user.id = token.id as string;
      return session;
    },
  },
});
