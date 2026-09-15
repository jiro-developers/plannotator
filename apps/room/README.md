# Plannotator Room (self-hosted)

플랜 마크다운(또는 HTML 문서)을 서버에 저장하고, **링크 하나(`/r/<code>`)로 팀원들이 동시에 인라인 코멘트·투표·답글·문서 확인**을 남기는 셀프호스팅 협업 방(room) 서비스입니다. 업스트림 Plannotator의 share URL(불변 스냅샷 전달) 모델과 달리, 코멘트가 서버에 누적되고 모두에게 공유됩니다.

주요 기능: 인라인/전체 코멘트와 답글·👍 투표 · 처리 상태(`open`/`answered`/`reflected`/`declined`) · 문서 확인(누가 확인했는지, 확인 후 갱신 여부 포함) · 버전 이력과 diff 뷰 · 에이전트에게 보내는 커밋 요청 신호 · 다른 방 링크 옆 확인 현황 배지.

- **인증**: Google OAuth(허용 도메인 검증) + HMAC 서명 무상태 세션 쿠키. 인증 변수 4종이 모두 설정될 때만 켜지며, 없으면 무인증 모드(로컬 개발용 — 이때는 사내망/VPN 뒤에서만).
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
| `GOOGLE_CLIENT_ID` | — | Google OAuth 클라이언트 ID (인증 활성화 조건 1/4) |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth 클라이언트 시크릿 (2/4) |
| `ROOM_SESSION_SECRET` | — | 세션 쿠키 HMAC 키, 예: `openssl rand -hex 32` (3/4). 교체 시 전체 세션 무효화 |
| `ROOM_ALLOWED_EMAIL_DOMAIN` | — | 로그인 허용 Google Workspace 도메인 (예: `example.com`). 인증 활성화 조건 4/4 — 기본값이 없으므로 명시해야 한다 |
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
| `POST` | `/api/rooms` | `{plan, title?, author?, renderAs?}` → `{id, url, version}`. `renderAs: "html"`이면 raw HTML 방(아래) |
| `GET` | `/api/rooms/:id` | 전체 스냅샷 |
| `GET` | `/api/rooms/:id/changes?since=N` | 변화 없으면 `304`. 에이전트 폴링 시각을 기록하고 `X-Agent-Last-Seen` 헤더로 회신 |
| `GET` | `/api/rooms/:id/plan-versions/:v` | 특정 버전의 플랜 본문 (이력 diff용, 방당 최대 50버전 보존) |
| `PUT` | `/api/rooms/:id/plan` | `{plan, note?, author?}` → planVersion 증가, changelog 기록 |
| `POST` | `/api/rooms/:id/annotations` | 뷰어 Annotation 필드 + `author` (id는 클라이언트 생성) |
| `POST` | `/api/rooms/:id/annotations/:aid/replies` | `{author, text}` |
| `POST` | `/api/rooms/:id/annotations/:aid/vote` | `{author}` — 토글 |
| `PATCH` | `/api/rooms/:id/annotations/:aid` | `{author, status?, text?}` — status: `open\|answered\|reflected\|declined`, text 수정은 작성자만 |
| `DELETE` | `/api/rooms/:id/annotations/:aid` | `{author}` — 작성자만 |
| `POST` / `DELETE` | `/api/rooms/:id/acks` | 문서 확인 등록/취소 (사용자당 1건, 로그인 이메일 기준 키) |
| `POST` / `DELETE` | `/api/rooms/:id/signals/commit` | 커밋 요청 신호 올리기 / 커밋 완료 보고(대기 해제 + 커밋된 planVersion 기록) |
| `POST` | `/api/rooms/ack-summaries` | `{ids: string[]}` → 여러 방의 확인 현황 일괄 조회 (최대 60개, 인덱스 문서용) |
| `GET` | `/api/me` · `POST` `/api/me/name` | 현재 로그인 사용자 조회 / 표시 이름 변경(세션 쿠키 재발급) |
| `GET` | `/auth/login` · `/auth/callback` · `POST` `/auth/logout` | Google OAuth 로그인 흐름 |
| `GET` | `/healthz` | 헬스체크 |

### HTML 문서 방

`renderAs: "html"`로 만든 방은 본문을 마크다운 대신 **sandbox iframe**(`allow-scripts`, same-origin 없음)으로 렌더합니다. 스크립트가 있는 인터랙티브 문서도 동작하지만 세션 쿠키에는 접근할 수 없습니다. 방 제목은 `<title>`에서 추출하고, 인라인 코멘트 대신 헤더의 **Global comment** 버튼으로 문서 전체 코멘트만 받습니다. 코멘트 패널·답글·투표·상태·문서 확인·이력(소스 raw diff)은 마크다운 방과 동일합니다.

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
