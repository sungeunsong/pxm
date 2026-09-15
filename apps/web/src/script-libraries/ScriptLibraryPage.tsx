import React, { useEffect, useMemo, useState } from "react";
import {
  Check,
  Download,
  Library,
  RotateCw,
  ShieldOff,
  Sparkles,
} from "lucide-react";
import { Button, Checkbox, Input } from "../components";
import { authzApi, type PxmGroup } from "../api/authz";
import {
  scriptLibrariesApi,
  type ScriptLibrary,
} from "../api/script-libraries";
import { useFeedback } from "../components/feedback/feedback-context";
import "./ScriptLibraryPage.css";

export const ScriptLibraryPage: React.FC = () => {
  const { toast, confirm: confirmDialog } = useFeedback();
  const [libraries, setLibraries] = useState<ScriptLibrary[]>([]);
  const [groups, setGroups] = useState<PxmGroup[]>([]);
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [resolvingLatest, setResolvingLatest] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [items, groupItems] = await Promise.all([
        scriptLibrariesApi.listAdmin(),
        authzApi.listGroups(false, true),
      ]);
      setLibraries(items);
      setGroups(groupItems.filter((group) => group.status === "active"));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "JS 라이브러리를 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const pendingCount = useMemo(
    () => libraries.filter((library) => library.status === "pending").length,
    [libraries],
  );

  const prepare = async () => {
    setPreparing(true);
    setError("");
    try {
      const item = await scriptLibrariesApi.prepare(packageName, version);
      setPackageName("");
      setVersion("");
      await load();
      toast.success(`${item.package_name}@${item.version} 준비가 끝났습니다.`, {
        description: "사용 범위를 확인하고 승인해 주세요.",
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "npm 패키지를 준비하지 못했습니다.",
      );
    } finally {
      setPreparing(false);
    }
  };

  const resolveLatest = async () => {
    setResolvingLatest(true);
    setError("");
    try {
      const resolved = await scriptLibrariesApi.resolveLatest(packageName);
      setVersion(resolved.version);
      toast.success(`최신 버전 ${resolved.version}을 확인했습니다.`, {
        description: "준비를 누르면 이 버전으로 고정해 등록합니다.",
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "최신 버전을 확인하지 못했습니다.",
      );
    } finally {
      setResolvingLatest(false);
    }
  };

  const approve = async (library: ScriptLibrary) => {
    setError("");
    try {
      await scriptLibrariesApi.approve(library.id, selectedGroups);
      await load();
      toast.success(
        `${library.package_name}@${library.version} 사용을 승인했습니다.`,
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "라이브러리를 승인하지 못했습니다.",
      );
    }
  };

  const disable = async (library: ScriptLibrary) => {
    const ok = await confirmDialog({
      title: "라이브러리 사용을 중지할까요?",
      description:
        "새로 저장하거나 배포하는 워크플로우에서 이 버전을 사용할 수 없게 됩니다.",
      confirmLabel: "사용 중지",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await scriptLibrariesApi.disable(library.id);
      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "라이브러리를 중지하지 못했습니다.",
      );
    }
  };

  return (
    <div className="script-library-page">
      <header className="script-library-header">
        <div>
          <h2>승인된 JS 라이브러리</h2>
          <p>
            정확한 npm 버전을 미리 준비하고, 허용할 그룹을 승인합니다. 실행
            중에는 패키지를 내려받지 않습니다.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCw size={14} />}
          onClick={load}
        >
          새로고침
        </Button>
      </header>

      {error && (
        <div className="script-library-error" role="alert">
          {error}
        </div>
      )}

      <section className="script-library-install">
        <div className="script-library-install-copy">
          <Download size={20} />
          <div>
            <strong>npm 패키지 준비</strong>
            <span>
              설치 스크립트는 실행하지 않으며 브라우저용으로 묶을 수 있는 순수
              JS 패키지만 허용합니다.
            </span>
          </div>
        </div>
        <div className="script-library-install-form">
          <Input
            label="패키지 이름"
            placeholder="lodash 또는 @company/common"
            value={packageName}
            onChange={(event) => setPackageName(event.target.value)}
          />
          <Input
            label="정확한 버전"
            placeholder="4.17.21"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          />
          <Button
            variant="secondary"
            icon={<Sparkles size={15} />}
            disabled={resolvingLatest || preparing || !packageName.trim()}
            onClick={resolveLatest}
          >
            {resolvingLatest ? "조회 중..." : "최신 버전"}
          </Button>
          <Button
            icon={<Download size={15} />}
            disabled={preparing || !packageName.trim() || !version.trim()}
            onClick={prepare}
          >
            {preparing ? "준비 중..." : "준비"}
          </Button>
        </div>
      </section>

      <section className="script-library-scope">
        <div>
          <strong>승인 범위</strong>
          <span>선택하지 않으면 모든 그룹에서 사용할 수 있습니다.</span>
        </div>
        <div className="script-library-group-list">
          {groups.map((group) => (
            <Checkbox
              key={group.id}
              label={group.name}
              checked={selectedGroups.includes(group.id)}
              onChange={(event) =>
                setSelectedGroups((current) =>
                  event.target.checked
                    ? [...current, group.id]
                    : current.filter((id) => id !== group.id),
                )
              }
            />
          ))}
        </div>
      </section>

      <div className="script-library-summary">
        <span>
          <Library size={15} /> 전체 {libraries.length}
        </span>
        <span>승인 대기 {pendingCount}</span>
      </div>

      <div className="script-library-list">
        {loading ? (
          <div className="script-library-empty">불러오는 중...</div>
        ) : libraries.length === 0 ? (
          <div className="script-library-empty">
            등록된 JS 라이브러리가 없습니다.
          </div>
        ) : (
          libraries.map((library) => (
            <article className="script-library-card" key={library.id}>
              <div className="script-library-card-main">
                <div className="script-library-name-row">
                  <strong>{library.package_name}</strong>
                  <code>{library.version}</code>
                  <span
                    className={`script-library-status is-${library.status}`}
                  >
                    {statusLabel(library.status)}
                  </span>
                </div>
                <p>{library.description || "설명이 없는 npm 패키지입니다."}</p>
                <div className="script-library-meta">
                  <span>라이선스 {library.license || "미표기"}</span>
                  <span>번들 {formatBytes(library.bundle_bytes)}</span>
                  <span>의존성 {library.dependency_count}개</span>
                  <span>해시 {library.bundle_sha256.slice(0, 12)}…</span>
                  <span>등록 {library.created_by}</span>
                  {library.approved_by && (
                    <span>승인 {library.approved_by}</span>
                  )}
                </div>
                {library.status === "approved" && (
                  <div className="script-library-groups">
                    사용 범위:{" "}
                    {library.allowed_group_ids.length === 0
                      ? "모든 그룹"
                      : library.allowed_group_ids
                          .map(
                            (id) =>
                              groups.find((group) => group.id === id)?.name ||
                              id,
                          )
                          .join(", ")}
                  </div>
                )}
              </div>
              <div className="script-library-card-actions">
                {library.status !== "approved" && (
                  <Button
                    size="sm"
                    icon={<Check size={14} />}
                    onClick={() => approve(library)}
                  >
                    승인
                  </Button>
                )}
                {library.status === "approved" && (
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<ShieldOff size={14} />}
                    onClick={() => disable(library)}
                  >
                    사용 중지
                  </Button>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
};

function statusLabel(status: ScriptLibrary["status"]) {
  if (status === "approved") return "사용 승인";
  if (status === "disabled") return "사용 중지";
  return "승인 대기";
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.ceil(bytes / 1024)}KB`;
}
