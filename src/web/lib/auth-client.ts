import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Without onTwoFactorRedirect the login page handles the second step itself.
export const authClient = createAuthClient({ basePath: "/api/auth", plugins: [twoFactorClient()] });
