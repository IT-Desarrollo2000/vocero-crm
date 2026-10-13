"use client";

import { createAuthClient } from "better-auth/react";

// Sin organizationClient(): `/organization/*` está bloqueado en el servidor
// (RF-00-10) y el equipo se gestiona por /api/settings/team/*.
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
