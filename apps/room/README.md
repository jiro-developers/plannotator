# Plannotator Room (self-hosted)

플랜 마크다운을 서버에 저장하고, **링크 하나(`/r/<code>`)로 팀원들이 동시에 인라인 코멘트·투표·답글**을 남기는 셀프호스팅 협업 방(room) 서비스입니다. 업스트림 Plannotator의 share URL(불변 스냅샷 전달) 모델과 달리, 코멘트가 서버에 누적되고 모두에게 공유됩니다.

- **인증**: Google OAuth(허용 도메인 검증) + HMAC 서명 무상태 세션 쿠키. 인증 변수 3종이 모두 설정될 때만 켜지며, 없으면 무인증 모드(로컬 개발용 — 이때는 사내망/VPN 뒤에서만).
- 에이전트(AI 세션)는 브라우저가 없으므로 `Authorization: Bearer <ROOM_AGENT_TOKEN>`으로 인증합니다. 모든 mutation의 author는 서버가 세션/토큰 주체로 강제 스탬프합니다(위조 방지).
- WebSocket 없음: 브라우저는 10초 간격 `changes?since=<version>` 폴링(변화 없으면 304).

## 로컬 실행

```bash
bun install
bun run build:room          # SPA 빌드 (dist/index.html 단일 파일)
bun run serve:room          # http://localhost:19434
```

개발 모드(HMR): `bun run serve:room` 띄운 상태에서 `bun run dev:room` → http://localhost:3002 (API는 19434로 프록시).

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` / `ROOM_PORT` | `19434` | 리슨 포트 (Railway는 `PORT` 자동 주입) |
| `DATABASE_URL` | — | 설정 시 Postgres 저장(테이블 `plannotator_rooms` 자동 생성). 미설정 시 파일 저장 |
| `ROOM_DATA_DIR` | `~/.plannotator/rooms` | 파일 저장 디렉토리 (fs 모드) |
| `ROOM_TTL_DAYS` | `90` | 마지막 수정 후 방 보존 기간 (0 이하 = 무제한) |
| `ROOM_MAX_PLAN_SIZE` | `2097152` | 플랜 최대 크기(byte) |
| `ROOM_ALLOWED_ORIGINS` | `*` | CORS 허용 origin (콤마 구분) — 운영에서는 정식 도메인으로 좁히기를 권장 |
| `ROOM_PUBLIC_URL` | 요청 origin | 정식 도메인. 설정 시 다른 호스트는 여기로 301 리다이렉트되고, OAuth 콜백 base로 쓰인다 |
| `GOOGLE_CLIENT_ID` | — | Google OAuth 클라이언트 ID (인증 활성화 조건 1/3) |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth 클라이언트 시크릿 (2/3) |
| `ROOM_SESSION_SECRET` | — | 세션 쿠키 HMAC 키, 예: `openssl rand -hex 32` (3/3). 교체 시 전체 세션 무효화 |
| `ROOM_ALLOWED_EMAIL_DOMAIN` | `jirocorp.io` | 로그인 허용 Google Workspace 도메인 |
| `ROOM_AGENT_TOKEN` | — | 에이전트 Bearer 토큰, 예: `openssl rand -hex 24` |

**시크릿은 전부 배포 환경 변수로만 관리합니다 — 이 저장소에는 어떤 시크릿도 커밋하지 않습니다.**

## Railway 배포

1. Railway → 서비스 Settings → **Source에 이 GitHub 저장소 연결** (배포 브랜치 지정). push하면 자동 배포된다.
   - repo 루트의 `railway.json`이 `apps/room/Dockerfile`로 빌드를 지정한다.
2. **Postgres 추가**: 프로젝트에 PostgreSQL 서비스 추가 → room 서비스 Variables에서 `DATABASE_URL`을 Postgres의 `DATABASE_URL` 참조(`${{Postgres.DATABASE_URL}}`)로 연결한다.
3. 위 환경변수 표의 인증 변수 5종 + `ROOM_PUBLIC_URL`(커스텀 도메인)을 설정한다.
4. Google Cloud Console의 OAuth 클라이언트에 `{ROOM_PUBLIC_URL}/auth/callback`을 승인된 리디렉션 URI로 등록한다.
5. 배포 후 `GET /healthz`로 확인.

## API

| Method | Path | Body / 비고 |
|---|---|---|
| `POST` | `/api/rooms` | `{plan, title?, author?}` → `{id, url, version}` |
| `GET` | `/api/rooms/:id` | 전체 스냅샷 |
| `GET` | `/api/rooms/:id/changes?since=N` | 변화 없으면 `304` |
| `PUT` | `/api/rooms/:id/plan` | `{plan, note?, author?}` → planVersion 증가, changelog 기록 |
| `POST` | `/api/rooms/:id/annotations` | 뷰어 Annotation 필드 + `author` (id는 클라이언트 생성) |
| `POST` | `/api/rooms/:id/annotations/:aid/replies` | `{author, text}` |
| `POST` | `/api/rooms/:id/annotations/:aid/vote` | `{author}` — 토글 |
| `PATCH` | `/api/rooms/:id/annotations/:aid` | `{author, status?, text?}` — status: `open\|answered\|reflected\|declined`, text 수정은 작성자만 |
| `DELETE` | `/api/rooms/:id/annotations/:aid` | `{author}` — 작성자만 |
| `GET` | `/healthz` | 헬스체크 |

`version`은 방의 모든 변경(플랜/코멘트/투표/답글/상태)마다 1씩 증가하는 단조 카운터로, 에이전트와 브라우저 폴링의 커서로 쓰입니다. `planVersion`은 플랜 본문이 바뀔 때만 증가하며, 브라우저는 이 값이 바뀌면 뷰어를 리마운트하고 하이라이트를 재앵커링합니다.

## 구조

```
apps/room/
├── core/          # 런타임 무관 로직 (types, handler, cors, storage 인터페이스)
├── stores/        # FsRoomStore(로컬) / PostgresRoomStore(Bun.sql, Railway)
├── targets/bun.ts # Bun.serve — API + SPA(단일 HTML) 서빙
├── ui/            # React SPA — @plannotator/ui의 Viewer/AnnotationPanel 재사용
└── Dockerfile     # 빌드 컨텍스트 = repo 루트
```

에이전트 쪽 워크플로우(게시→폴링→반영)는 `~/.claude/skills/plan-room-polling` 스킬을 참고하세요.
