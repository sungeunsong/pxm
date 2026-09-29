import { apiErrorFromBody } from '../lib/api-error';
export type ScriptLibraryStatus = "pending" | "approved" | "disabled";

export interface ScriptLibrary {
  id: string;
  package_name: string;
  version: string;
  description: string;
  license: string;
  integrity: string;
  bundle_sha256: string;
  bundle_bytes: number;
  dependency_count: number;
  status: ScriptLibraryStatus;
  allowed_group_ids: string[];
  created_by: string;
  approved_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScriptLibraryRef {
  package_name: string;
  version: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/script-libraries${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw apiErrorFromBody(response, body, 'JS 라이브러리 요청에 실패했습니다.');
  return body;
}

export const scriptLibrariesApi = {
  listAvailable: () => request<ScriptLibrary[]>(""),
  listAdmin: () => request<ScriptLibrary[]>("/admin"),
  resolveLatest: (packageName: string) =>
    request<ScriptLibraryRef>("/resolve-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_name: packageName }),
    }),
  prepare: (packageName: string, version: string) =>
    request<ScriptLibrary>("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_name: packageName, version }),
    }),
  approve: (id: string, allowedGroupIds: string[]) =>
    request<ScriptLibrary>(`/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowed_group_ids: allowedGroupIds }),
    }),
  disable: (id: string) =>
    request<ScriptLibrary>(`/${encodeURIComponent(id)}/disable`, {
      method: "POST",
    }),
};
