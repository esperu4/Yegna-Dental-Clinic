/**
 * Google Drive for the nightly backup (PRD §17): an OAuth refresh token of the clinic's own
 * account, scope `drive.file` (the app sees only the files it created). Upload, list our backups,
 * delete expired ones. Errors carry the HTTP status only, never a body (it could echo data).
 */

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface DriveFile {
  id: string;
  name: string;
  /** Clinic local date of the backup (`appProperties.date`). */
  date: string;
}

export class DriveError extends Error {
  override name = 'DriveError';
  constructor(
    readonly step: 'token' | 'upload' | 'list' | 'delete' | 'download',
    readonly status: number,
  ) {
    super(`drive_${step}_${status}`);
  }
}

type Fetch = typeof fetch;

const API = 'https://www.googleapis.com';
/** Marks our files, so listing never touches anything else. */
const APP_KEY = 'yegnaBackup';

/**
 * `environment` tags every file and filters every listing: staging and production never see (or
 * delete) each other's backups, even through one Google app.
 */
export function driveClient(
  credentials: DriveCredentials,
  environment: string,
  fetchImpl: Fetch = (i, o) => fetch(i, o),
) {
  if (!/^[a-z]+$/.test(environment)) throw new Error('bad environment name');
  let token: string | undefined;

  async function accessToken(): Promise<string> {
    if (token) return token;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new DriveError('token', res.status);
    token = ((await res.json()) as { access_token: string }).access_token;
    return token;
  }

  const auth = async () => ({ Authorization: `Bearer ${await accessToken()}` });

  return {
    async upload(name: string, date: string, content: Uint8Array): Promise<string> {
      const boundary = `yegna${crypto.randomUUID().replaceAll('-', '')}`;
      const metadata = JSON.stringify({
        name,
        mimeType: 'application/octet-stream',
        appProperties: { [APP_KEY]: '1', env: environment, date },
      });
      const head = new TextEncoder().encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.byteLength + content.byteLength + tail.byteLength);
      body.set(head, 0);
      body.set(content, head.byteLength);
      body.set(tail, head.byteLength + content.byteLength);
      const res = await fetchImpl(`${API}/upload/drive/v3/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { ...(await auth()), 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!res.ok) throw new DriveError('upload', res.status);
      return ((await res.json()) as { id: string }).id;
    },

    async list(): Promise<DriveFile[]> {
      const files: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({
          q: `appProperties has { key='${APP_KEY}' and value='1' } and appProperties has { key='env' and value='${environment}' } and trashed = false`,
          fields: 'nextPageToken, files(id, name, appProperties)',
          pageSize: '1000',
          ...(pageToken ? { pageToken } : {}),
        });
        const res = await fetchImpl(`${API}/drive/v3/files?${q}`, { headers: await auth() });
        if (!res.ok) throw new DriveError('list', res.status);
        const page = (await res.json()) as {
          nextPageToken?: string;
          files: { id: string; name: string; appProperties?: { date?: string } }[];
        };
        for (const f of page.files) {
          if (f.appProperties?.date) files.push({ id: f.id, name: f.name, date: f.appProperties.date });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return files;
    },

    async remove(id: string): Promise<void> {
      const res = await fetchImpl(`${API}/drive/v3/files/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: await auth(),
      });
      if (!res.ok && res.status !== 404) throw new DriveError('delete', res.status);
    },

    async download(id: string): Promise<Uint8Array> {
      const res = await fetchImpl(`${API}/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {
        headers: await auth(),
      });
      if (!res.ok) throw new DriveError('download', res.status);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export type DriveClient = ReturnType<typeof driveClient>;
