import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { AuthShell } from "./AuthShell";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await authClient.signIn.email({ email, password, rememberMe: true });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Sign in failed");
      return;
    }
    navigate("/", { replace: true });
  }

  return (
    <AuthShell title="Sign in">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
