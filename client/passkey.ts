// Account buttons on the login and account pages: [data-passkey-login], [data-passkey-register], [data-passkey-delete="<id>"] and [data-account-delete]. The server sends WebAuthn options and checks the answers; @simplewebauthn/browser talks to the authenticator. Each button carries its failure message in data-fail.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
}

async function logIn(): Promise<void> {
  const options = await (await post("/auth/passkey/login/options")).json();
  const answer = await startAuthentication({ optionsJSON: options });
  const res = await post("/auth/passkey/login/verify", answer);
  if (!res.ok) throw new Error(String(res.status));
}

async function register(): Promise<void> {
  const options = await (await post("/auth/passkey/register/options")).json();
  const answer = await startRegistration({ optionsJSON: options });
  const res = await post("/auth/passkey/register/verify", answer);
  if (!res.ok) throw new Error(String(res.status));
}

async function remove(id: string): Promise<void> {
  const res = await fetch(`/api/me/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
  if (!res.ok) throw new Error(String(res.status));
}

async function deleteAccount(withFiles: boolean): Promise<void> {
  const res = await fetch("/api/me", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delete_files: withFiles }),
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(String(res.status));
}

/** Wires the buttons with one delegated listener, so pages swapped in by the site navigation work too. */
export function initPasskeys(notify: (msg: string) => void): void {
  document.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-passkey-login], [data-passkey-register], [data-passkey-delete], [data-account-delete]",
    );
    if (!btn || btn.disabled) return;
    if (btn.hasAttribute("data-account-delete") && !confirm(btn.dataset.confirm ?? "")) return;
    btn.disabled = true;
    try {
      if (btn.hasAttribute("data-account-delete")) {
        await deleteAccount((document.getElementById("delete-files") as HTMLInputElement | null)?.checked === true);
        location.href = "/";
        return;
      }
      if (btn.hasAttribute("data-passkey-login")) await logIn();
      else if (btn.hasAttribute("data-passkey-register")) await register();
      else await remove(btn.dataset.passkeyDelete!);
      location.href = btn.hasAttribute("data-passkey-delete") ? "/account" : "/account?welcome=1";
    } catch (err) {
      // Cancelling the browser prompt is not an error worth showing.
      if (!(err instanceof Error && err.name === "NotAllowedError")) notify(btn.dataset.fail ?? "Error");
      btn.disabled = false;
    }
  });
}
