# 운영 Secret 파일

이 디렉터리의 실제 Secret 파일은 Git에 커밋하지 않는다. 각 파일은 줄바꿈 없이
값 하나만 가지며 운영 서버에서 권한 `0600`으로 생성한다.

- `mongodb_url`: `mongodb://pxm_app:<encoded-password>@mongodb:27017/?replicaSet=rs0&authSource=pxm`
- `mongo_root_password`: MongoDB 관리 계정 비밀번호
- `mongo_app_password`: PXM 전용 최소 권한 DB 계정 비밀번호
- `mongo_keyfile`: `openssl rand -base64 756`으로 만든 replica set 내부 인증키
- `credential_secret_key`: 32자 이상의 Credential 암호화 키
- `bootstrap_admin_password`: 16자 이상의 임시 최초 관리자 비밀번호
- `external_approval_secret`: 32자 이상의 외부 결재 토큰 서명키
- `smtp_password`: SMTP를 사용하지 않으면 임의의 비사용 Secret을 둔다.
- `tls_cert.pem`, `tls_key.pem`: 운영 도메인의 인증서와 개인키

최초 로그인 직후 관리자 비밀번호를 변경하면 bootstrap 비밀번호는 더 이상 인증에
사용되지 않는다. 변경 완료 후에는 Secret 저장소에서도 bootstrap 값을 교체한다.
