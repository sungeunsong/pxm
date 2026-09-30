/**
 * 진입점 등록 정보 — 워크플로우를 바깥에 공개하는 입구 설정.
 *
 * AI Tool(kind=tool)과 게이트웨이 라우트(kind=route)가 같은 저장소를 쓴다.
 * 등록·버전 고정·입력 계약·권한·이력은 한 벌이고, 입구별 설정만 tool / route 아래에 둔다.
 * 설계: docs/entry-points-design.md 2장
 */
export type EntryPointKind = 'tool' | 'route';
export type EntryPointStatus = 'draft' | 'active' | 'disabled';
export type EntryPointSideEffect =
  | 'read_only'
  | 'mutating'
  | 'requires_approval';
export type EntryPointOutputContract = 'declared' | 'free_form';
export type EntryPointInputSchemaSource = 'derived' | 'manual';
export type EntryPointHistoryBody = 'none' | 'masked';

export type EntryPointToolSpec = {
  /** ^[a-z][a-z0-9_]{2,63}$, 그룹 안에서 유일 */
  name: string;
  display_name?: string | null;
};

export type EntryPointRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type EntryPointRouteSpec = {
  method: EntryPointRouteMethod;
  /** /gw/{namespace}/... 전체 경로. 경로 변수는 {name} */
  path: string;
  mode: 'passthrough' | 'approval';
  response_mode: 'backend' | 'result_json';
  timeout_ms: number;
  forward_headers: string[];
};

/** 게시 시점의 의존 자원 스냅샷. 권한이 아니라 진단용이다 */
export type EntryPointResourceDigest = {
  computed_at: string;
  plugins: string[];
  script_libraries: string[];
  credentials: string[];
  commands: string[];
  workflow_calls: string[];
};

export type EntryPoint = {
  id: string;
  kind: EntryPointKind;
  group_id: string;
  /** 예약 필드. 권한 판정에 쓰지 않고 group_id를 복사해 넣지 않는다 */
  tenant_id: string | null;
  definition_id: string;
  pinned_version: number;
  input_schema: Record<string, any>;
  input_schema_source: EntryPointInputSchemaSource;
  output_schema: Record<string, any> | null;
  output_contract: EntryPointOutputContract;
  side_effect: EntryPointSideEffect;
  status: EntryPointStatus;
  description: string;
  tags: string[];
  resource_digest: EntryPointResourceDigest | null;
  history_policy: { body: EntryPointHistoryBody };
  tool: EntryPointToolSpec | null;
  route: EntryPointRouteSpec | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type EntryPointQuery = {
  kind?: EntryPointKind;
  /** 주어지면 이 그룹들의 진입점만 */
  group_ids?: string[];
  definition_id?: string;
  status?: EntryPointStatus;
  tool_name?: string;
  route?: { method: EntryPointRouteMethod; path: string };
};

export type EntryPointPatch = Partial<
  Pick<
    EntryPoint,
    | 'pinned_version'
    | 'input_schema'
    | 'input_schema_source'
    | 'output_schema'
    | 'output_contract'
    | 'side_effect'
    | 'status'
    | 'description'
    | 'tags'
    | 'resource_digest'
    | 'history_policy'
    | 'tool'
    | 'route'
  >
> & { updated_by: string | null };

/** 같은 그룹의 Tool 이름, 또는 같은 라우트 경로가 이미 있다 */
export class EntryPointConflictError extends Error {
  constructor(message = 'entry point already exists') {
    super(message);
    this.name = 'EntryPointConflictError';
  }
}

export abstract class EntryPointRepositoryPort {
  /** 중복이면 EntryPointConflictError */
  abstract createEntryPoint(entry: EntryPoint): Promise<EntryPoint>;
  abstract getEntryPoint(id: string): Promise<EntryPoint | null>;
  abstract listEntryPoints(query?: EntryPointQuery): Promise<EntryPoint[]>;
  /** 없으면 null. 중복이면 EntryPointConflictError */
  abstract updateEntryPoint(
    id: string,
    patch: EntryPointPatch,
  ): Promise<EntryPoint | null>;
  abstract deleteEntryPoint(id: string): Promise<boolean>;
}
