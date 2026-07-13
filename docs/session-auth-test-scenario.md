# Session Authentication Test Scenario

## Test Environment

- Web: `http://localhost:5174`
- API: `http://localhost:3011/api`
- Local bootstrap account: `admin` / `admin1234`
- MongoDB database: `pxm_db`

운영 환경에서는 bootstrap 비밀번호를 반드시 환경변수로 변경한다. 로그인 실패 제한 테스트 외에는 잘못된 비밀번호를 반복 입력하지 않는다.

## 1. Login Page And Session Creation

1. 시크릿 창에서 Web에 접속한다.
2. 로그인 페이지가 표시되는지 확인한다.
3. `admin` / `admin1234`로 로그인한다.
4. 관리 콘솔과 최고관리자 메뉴가 표시되는지 확인한다.
5. 브라우저 개발자 도구의 Application > Cookies에서 아래 쿠키를 확인한다.
   - 로컬: `pxm_session`, `pxm_csrf`
   - 운영 HTTPS: `__Host-pxm_session`, `__Host-pxm_csrf`
6. `pxm_session`은 HttpOnly이고 `pxm_csrf`는 HttpOnly가 아닌지 확인한다.

Expected:

- 로그인 응답은 `200`이다.
- 세션 원문이나 사용자 role을 Local Storage/Session Storage에 저장하지 않는다.
- MongoDB `pxm_sessions`에는 `token_hash`, `csrf_hash`만 있고 쿠키 원문은 없다.

## 2. Refresh And API Restart Persistence

1. 로그인 상태에서 브라우저를 새로고침한다.
2. 로그인 화면으로 돌아가지 않는지 확인한다.
3. API 서버만 재시작한다.
4. 브라우저를 다시 새로고침한다.

Expected:

- 브라우저 새로고침과 API 재시작 후에도 DB 세션이 유효하면 로그인 상태가 유지된다.

## 3. CSRF Protection

로그인 후 개발자 도구에서 `pxm_session` 쿠키 값을 복사하고 다음 요청을 실행한다. CSRF 토큰은 보내지 않는다.

```bash
curl -i -X POST http://localhost:3011/api/authz/groups \
  -H 'Content-Type: application/json' \
  -H 'Cookie: pxm_session=<SESSION_COOKIE>' \
  --data '{"name":"csrf-block-test"}'
```

Expected:

- `403 Forbidden`
- 응답 메시지: `CSRF token is invalid`
- 그룹이 생성되지 않는다.

정상 Web UI에서 그룹을 생성해 본다.

Expected:

- Web은 CSRF 헤더를 자동으로 추가하며 그룹 생성에 성공한다.

## 4. Logout And Revocation

1. 로그아웃 버튼을 누른다.
2. 로그인 페이지가 표시되는지 확인한다.
3. 이전 세션 쿠키로 `/api/auth/me`를 호출한다.

Expected:

- 로그아웃 API는 `200`이다.
- 이전 세션으로 `/api/auth/me` 호출 시 `401`이다.
- DB 세션에 `revoked_at`과 `revoke_reason: logout`이 기록된다.

## 5. Concurrent Session Management

1. 일반 창과 시크릿 창에서 같은 계정으로 각각 로그인한다.
2. `GET /api/auth/sessions`를 호출해 두 세션이 표시되는지 확인한다.
3. 한 세션에서 다른 세션을 `DELETE /api/auth/sessions/:id`로 폐기한다.
4. 폐기된 브라우저에서 새로고침한다.
5. 다시 두 창에서 로그인하고 `POST /api/auth/sessions/revoke-others`를 호출한다.

Expected:

- 원격 폐기된 브라우저는 다음 요청에서 `401`이 되고 로그인 페이지로 이동한다.
- `revoke-others`를 호출한 현재 세션만 유지된다.

## 6. Role And Group Boundary

1. admin으로 group과 `group_manager` 사용자를 생성하고 초기 비밀번호를 지정한다.
2. 해당 사용자로 로그인한다.
3. Access Management에는 할당된 group만 표시되는지 확인한다.
4. 다른 group ID의 관리 API를 직접 호출한다.
5. `user` role 계정으로 로그인한다.

Expected:

- `group_manager`는 자기 group만 관리할 수 있다.
- 다른 group 관리 요청은 `403`이다.
- `user`에게 Access Management, Credential, Designer, Command/Plugin 관리 메뉴가 표시되지 않는다.

## 7. Idle And Absolute Expiration

기본 정책:

- idle timeout: 30분
- absolute timeout: 로그인 후 8시간

짧은 시간에 검증하려면 테스트 DB에서 현재 세션의 `idle_expires_at` 또는 `absolute_expires_at`을 과거로 변경한 뒤 새로고침한다.

```javascript
const session = db.pxm_sessions.find({ user_id: "admin", revoked_at: null }).sort({ created_at: -1 }).limit(1).next()
db.pxm_sessions.updateOne(
  { _id: session._id },
  { $set: { idle_expires_at: new Date(Date.now() - 1000).toISOString() } }
)
```

Expected:

- 다음 요청은 `401`이다.
- 해당 세션에 `revoke_reason: expired`가 기록된다.
- 지속적으로 활동해도 absolute 8시간을 넘으면 재로그인이 필요하다.

## 8. Login Failure Limit

테스트 전용 계정 또는 테스트 환경에서만 수행한다.

1. 동일한 IP와 user ID로 잘못된 비밀번호를 5회 입력한다.
2. 즉시 올바른 비밀번호로 로그인한다.
3. 15분 후 다시 로그인한다.

Expected:

- 5회 실패 이후 `429 Too Many Requests`가 반환된다.
- 차단 시간 동안 올바른 비밀번호도 거부된다.
- 15분 후 다시 로그인할 수 있다.

현재 로그인 실패 제한은 API 프로세스 메모리 기반이다. 다중 서버 운영 검증 전 Redis 등 공용 저장소로 교체해야 한다.
