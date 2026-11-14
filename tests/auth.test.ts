import { describe, expect, test } from "bun:test";
import { auth, hasAccount } from "../src/server/auth/auth";
import { db } from "../src/server/db/client";
import { user } from "../src/server/db/schema";

function signUp(email: string) {
  return auth.api
    .signUpEmail({ body: { email, password: "password123", name: email } })
    .then(() => true)
    .catch(() => false);
}

describe("single account setup", () => {
  test("only one of two simultaneous registrations succeeds", async () => {
    expect(hasAccount()).toBe(false);
    const results = await Promise.all([signUp("a@example.com"), signUp("b@example.com"), signUp("c@example.com")]);
    expect(results.filter(Boolean).length).toBe(1);
    expect(db.select().from(user).all().length).toBe(1);
    expect(hasAccount()).toBe(true);
  });

  test("registration stays closed afterwards", async () => {
    expect(await signUp("late@example.com")).toBe(false);
  });
});
