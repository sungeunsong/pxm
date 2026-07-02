# Command Node Execution Model

Phase 3의 Command Node는 운영 안전성을 위해 임의 shell 실행을 제공하지 않는다. Runtime은 `command_id` 기반 allowlist registry만 실행한다.

## Local Allowlist Executor

- node config는 `commandId`, `commandArgumentsJson`, `commandTimeoutMs`, `outputPath`를 가진다.
- engine은 내장 registry, `PXM_COMMAND_REGISTRY_JSON`, MongoDB `command_registry`에서 `command_id`를 찾는다.
- registry spec은 executable, fixed args, `arg_order`, timeout, stdout/stderr byte limit, working directory를 정의한다.
- shell 문자열은 실행하지 않고 `Command::new(executable).args(...)` 형태로만 실행한다.
- 실행 결과는 output path에 `command_id`, `exit_code`, `success`, `timed_out`, `duration_ms`, `stdout`, `stderr`로 저장한다.
- audit event는 `PXM_COMMAND_AUDIT_LOG` 또는 `logs/command-audit.jsonl`에 JSONL로 남긴다.

## Registry Example

```json
{
  "commands": {
    "ops.echo": {
      "executable": "/usr/bin/printf",
      "fixed_args": ["%s"],
      "arg_order": ["message"],
      "timeout_ms": 1000,
      "max_stdout_bytes": 4096,
      "max_stderr_bytes": 4096
    }
  }
}
```

## Management API And UI

최고관리자는 `Command Registry` 화면 또는 API로 command를 등록한다.

```text
GET /api/commands
GET /api/commands/:command_id
POST /api/commands
PUT /api/commands/:command_id
DELETE /api/commands/:command_id
GET /api/commands/audit
```

쓰기 API는 `admin` role actor만 허용한다. 현재 개발 환경에서는 UI가 임시 admin header를 붙이고, 운영에서는 인증/JWT claim으로 대체한다.

Designer의 Command Node는 `GET /api/commands?activeOnly=true` 목록을 dropdown으로 보여준다. 목록에는 engine 내장 command와 MongoDB에 등록된 command가 함께 노출된다.

## External Agent Position

External agent 실행은 local command executor와 분리한다. command node가 직접 네트워크 agent를 호출하지 않고, 별도 Phase 3 `External agent 실행 모델`에서 registration, heartbeat, dispatch, result collection, network/security model을 구현한다.

이 분리는 다음 이유 때문이다.

- local command는 API/engine host의 allowlist 실행 문제다.
- external agent는 원격 worker identity, queue ownership, heartbeat timeout, result replay, network trust가 필요한 별도 분산 실행 모델이다.
- 두 모델을 같은 executor에 섞으면 audit, retry, cancel, timeout 경계가 불명확해진다.
