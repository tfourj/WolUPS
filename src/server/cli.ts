import { and, eq } from "drizzle-orm";
import { db, runMigrations } from "./db/client";
import { account, session, twoFactor, user } from "./db/schema";
import { auth } from "./auth/auth";

// Recovery commands, run inside the container: `bun src/server/cli.ts <command>`

function getOwner() {
  runMigrations();
  const owner = db.select().from(user).get();
  if (!owner) {
    console.error("No account exists yet. Open WolUPS in a browser to create one.");
    process.exit(1);
  }
  return owner;
}

async function resetPassword(password: string | undefined) {
  if (!password || password.length < 8) {
    console.error("Usage: reset-password <new-password> (at least 8 characters)");
    process.exit(1);
  }
  const owner = getOwner();
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);
  db.update(account)
    .set({ password: hash, updatedAt: new Date() })
    .where(and(eq(account.userId, owner.id), eq(account.providerId, "credential")))
    .run();
  db.delete(session).where(eq(session.userId, owner.id)).run();
  console.log(`Password reset for ${owner.email}. All sessions were signed out.`);
}

/** For a lost authenticator app and backup codes. */
function disableTwoFactor() {
  const owner = getOwner();
  db.delete(twoFactor).where(eq(twoFactor.userId, owner.id)).run();
  db.update(user).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(user.id, owner.id)).run();
  console.log(`Two-factor authentication turned off for ${owner.email}.`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "reset-password") await resetPassword(args[0]);
else if (command === "disable-2fa") disableTwoFactor();
else {
  console.log("Commands:\n  reset-password <new-password>\n  disable-2fa");
  process.exit(command ? 1 : 0);
}
