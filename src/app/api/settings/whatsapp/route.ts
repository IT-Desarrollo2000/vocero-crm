import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  getCredentialsByOrg,
  saveCredentials,
  tokenLast4,
} from "@/server/whatsapp/credentials";
import {
  checkWabaAccess,
  subscribeAppToWaba,
  testConnection,
} from "@/server/whatsapp/connect";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      wabaId: creds.wabaId,
      phoneNumberId: creds.phoneNumberId,
      displayPhoneNumber: creds.displayPhoneNumber,
      verifiedName: creds.verifiedName,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
    },
  });
}, { role: "owner" });

const putSchema = z.object({
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
  token: z.string().trim().min(1),
});

/** Guarda la conexión: re-valida contra Meta, cifra y suscribe (FR-040). */
export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  const check = await testConnection(body.data.phoneNumberId, body.data.token);
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }

  // Dos señales de que el token lee el número pero no puede enviar: su
  // usuario no está asignado a la WABA y Meta rechaza suscribir la app. Con
  // ambas se rechaza sin guardar; con una sola (p. ej. modo agencia, donde la
  // suscripción la hace el backend de la agencia) se guarda con aviso.
  const access = await checkWabaAccess(body.data.wabaId, body.data.token);
  const sub = await subscribeAppToWaba(body.data.wabaId, body.data.token);
  const notAssigned =
    access.ok === false
      ? `El usuario del token («${access.userName}») no tiene asignada esta cuenta de WhatsApp: puede leer el número pero Meta rechazará los envíos. En Business Manager → Usuarios del sistema → ${access.userName} → Asignar activos → Cuentas de WhatsApp, dale control total, o usa el token de un usuario del sistema que ya la tenga.`
      : null;
  if (notAssigned && !sub.ok) {
    return apiError(422, "waba_not_assigned", notAssigned);
  }

  await saveCredentials({
    organizationId: session.organizationId,
    wabaId: body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    token: body.data.token,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
  });

  const warnings = [
    notAssigned,
    sub.ok
      ? null
      : `La conexión quedó guardada, pero no se pudo suscribir la app a la cuenta de WhatsApp (${sub.detail}): Meta no entregará los mensajes al CRM hasta que se suscriba. Si usas modo agencia, la suscripción la hace el backend de tu agencia.`,
  ].filter((w): w is string => w !== null);

  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
    subscribed: sub.ok,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  });
}, { role: "owner" });
