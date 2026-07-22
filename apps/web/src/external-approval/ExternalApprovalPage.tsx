import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import {
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import "./ExternalApprovalPage.css";

type ApprovalDetails = {
  task_id: string;
  status: string;
  workflow_name?: string | null;
  node_id: string;
  recipient: string;
  requires_otp: boolean;
  expires_at: string;
  form_data: Record<string, unknown>;
};

export function ExternalApprovalPage({ token }: { token: string }) {
  const [details, setDetails] = useState<ApprovalDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [comment, setComment] = useState("");
  const [completed, setCompleted] = useState<"approve" | "reject" | null>(null);

  useEffect(() => {
    readJson(`/api/external-approvals/${encodeURIComponent(token)}`)
      .then(setDetails)
      .catch((cause) => setError(errorText(cause)))
      .finally(() => setLoading(false));
  }, [token]);

  const requestOtp = async () => {
    setBusy(true);
    setError("");
    try {
      await readJson(
        `/api/external-approvals/${encodeURIComponent(token)}/otp`,
        { method: "POST" },
      );
      setOtpSent(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const complete = async (
    event: SyntheticEvent,
    action: "approve" | "reject",
  ) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await readJson(
        `/api/external-approvals/${encodeURIComponent(token)}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            comment: comment.trim() || undefined,
            otp: details?.requires_otp ? otp : undefined,
          }),
        },
      );
      setCompleted(action);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  if (loading)
    return (
      <main className="external-approval-shell">
        <div className="external-approval-card centered">
          <LoaderCircle className="spin" />
          <p>승인 요청을 확인하고 있습니다.</p>
        </div>
      </main>
    );
  if (completed)
    return (
      <main className="external-approval-shell">
        <div className="external-approval-card centered">
          <CheckCircle2 className="success-icon" />
          <h1>{completed === "approve" ? "승인했습니다" : "반려했습니다"}</h1>
          <p>처리가 완료되었습니다. 이 창을 닫아도 됩니다.</p>
        </div>
      </main>
    );
  if (!details)
    return (
      <main className="external-approval-shell">
        <div className="external-approval-card centered">
          <XCircle className="error-icon" />
          <h1>승인 요청을 열 수 없습니다</h1>
          <p>{error || "링크가 만료되었거나 더 이상 유효하지 않습니다."}</p>
        </div>
      </main>
    );

  return (
    <main className="external-approval-shell">
      <form
        className="external-approval-card"
        onSubmit={(event) => void complete(event, "approve")}
      >
        <header>
          <div className="external-brand">
            <ShieldCheck />
            <div>
              <strong>PXM</strong>
              <span>External Approval</span>
            </div>
          </div>
          <span className="external-status">승인 대기</span>
        </header>
        <section className="external-title">
          <p>승인 요청</p>
          <h1>{details.workflow_name || "PXM 워크플로우"}</h1>
          <span>
            {details.recipient} ·{" "}
            {new Date(details.expires_at).toLocaleString()}까지
          </span>
        </section>
        <section>
          <h2>요청 내용</h2>
          <div className="approval-fields">
            {Object.keys(details.form_data || {}).length ? (
              Object.entries(details.form_data).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  <strong>{displayValue(value)}</strong>
                </div>
              ))
            ) : (
              <p className="empty-data">표시할 입력 데이터가 없습니다.</p>
            )}
          </div>
        </section>
        {details.requires_otp && (
          <section>
            <h2>
              <KeyRound size={17} /> 이메일 인증
            </h2>
            <p className="section-help">
              승인 처리 전 {details.recipient}로 전송된 6자리 인증번호를
              입력하세요.
            </p>
            <div className="otp-row">
              <input
                value={otp}
                onChange={(event) =>
                  setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                aria-label="6자리 인증번호"
              />
              <button
                type="button"
                className="secondary"
                onClick={() => void requestOtp()}
                disabled={busy}
              >
                {otpSent ? "다시 받기" : "인증번호 받기"}
              </button>
            </div>
            {otpSent && (
              <small>인증번호를 발송했습니다. 10분 안에 입력해 주세요.</small>
            )}
          </section>
        )}
        <section>
          <label htmlFor="approval-comment">
            의견 <span>(선택)</span>
          </label>
          <textarea
            id="approval-comment"
            maxLength={2000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="처리 의견을 입력하세요."
          />
        </section>
        {error && <div className="external-error">{error}</div>}
        <footer>
          <button
            type="button"
            className="reject"
            disabled={busy || (details.requires_otp && otp.length !== 6)}
            onClick={(event) => void complete(event, "reject")}
          >
            <XCircle size={17} /> 반려
          </button>
          <button
            type="submit"
            className="approve"
            disabled={busy || (details.requires_otp && otp.length !== 6)}
          >
            <CheckCircle2 size={17} /> {busy ? "처리 중…" : "승인"}
          </button>
        </footer>
      </form>
    </main>
  );
}

async function readJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body?.message || "요청을 처리하지 못했습니다.");
  return body;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : "요청을 처리하지 못했습니다.";
}
function displayValue(value: unknown) {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}
