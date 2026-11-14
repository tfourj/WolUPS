import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Field } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { AuthShell } from "./AuthShell";

type CodeMode = "totp" | "backup";

/** Second sign-in step for an account with two-factor authentication. */
function TwoFactorForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<CodeMode>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const input = { code: code.replace(/\s+/g, ""), trustDevice };
    const { error } =
      mode === "totp"
        ? await authClient.twoFactor.verifyTotp(input)
        : await authClient.twoFactor.verifyBackupCode(input);
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Invalid code");
      return;
    }
    onDone();
  }

  function switchMode() {
    setMode(mode === "totp" ? "backup" : "totp");
    setCode("");
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label={mode === "totp" ? "Authenticator code" : "Backup code"} htmlFor="code">
        <Input
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode={mode === "totp" ? "numeric" : "text"}
          maxLength={mode === "totp" ? 6 : 32}
          placeholder={mode === "totp" ? "123456" : "XXXXX-XXXXX"}
          required
          autoFocus
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={trustDevice} onCheckedChange={(v) => setTrustDevice(v === true)} />
        Trust this device for 30 days
      </label>
      <Button type="submit" disabled={busy}>
        Verify
      </Button>
      <div className="flex justify-between text-sm">
        <button type="button" className="text-muted-foreground underline-offset-4 hover:underline" onClick={onCancel}>
          Back
        </button>
        <button type="button" className="text-muted-foreground underline-offset-4 hover:underline" onClick={switchMode}>
          {mode === "totp" ? "Use a backup code" : "Use authenticator app"}
        </button>
      </div>
    </form>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const navigate = useNavigate();

  const finish = () => navigate("/", { replace: true });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await authClient.signIn.email({ email, password, rememberMe: true });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Sign in failed");
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setPassword("");
      setNeedsCode(true);
      return;
    }
    finish();
  }

  if (needsCode) {
    return (
      <AuthShell title="Two-factor authentication">
        <TwoFactorForm onDone={finish} onCancel={() => setNeedsCode(false)} />
      </AuthShell>
    );
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
