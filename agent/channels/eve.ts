import { eveChannel } from "eve/channels/eve";
import { localDev, none, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // Wave 0: the channel itself is open; the production gate is Vercel
    // Deployment Protection (Vercel Authentication) at the platform layer —
    // enable it for Production in the project settings. Replace with real
    // app auth (Auth.js/Clerk) before kerf is multi-user; the agent spends
    // Browser Use credits per request, so do not ship none() unprotected.
    none(),
  ],
});
