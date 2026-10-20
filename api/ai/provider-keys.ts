// Platform-admin-only runtime provider key management. Secret values are
// accepted once, encrypted on the server, and never returned to the browser.
import { z } from 'zod';
import { authenticate } from '../../server/database.js';
import { errorResponse, HttpError, json, readJson } from '../../server/http.js';
import { providerKeySource, removeProviderKey, saveProviderKey } from '../../server/provider-secrets.js';
import { reportPlatform } from '../../server/startup.js';

const bodySchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  api_key: z.string().trim().min(20).max(500).nullable(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    if (user.appMetadata?.platform_admin !== true) {
      throw new HttpError(403, 'forbidden', 'Only the platform administrator can change provider keys.');
    }
    const body = await readJson(request, bodySchema);
    if (body.api_key) await saveProviderKey(body.provider, body.api_key);
    else await removeProviderKey(body.provider);
    await reportPlatform();
    const source = providerKeySource(body.provider);
    return json({ provider: body.provider, configured: source !== 'none', source });
  } catch (error) {
    return errorResponse(error);
  }
}
