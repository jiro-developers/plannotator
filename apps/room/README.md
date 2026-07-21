# Plannotator Room (self-hosted)

플랜 마크다운을 서버에 저장하고, **링크 하나(`/r/<code>`)로 팀원들이 동시에 인라인 코멘트·투표·답글**을 남기는 셀프호스팅 협업 방(room) 서비스입니다. 업스트림 Plannotator의 share URL(불변 스냅샷 전달) 모델과 달리, 코멘트가 서버에 누적되고 모두에게 공유됩니다.

- 인증 없음(MVP): shortcode가 유일한 비밀. **사내망/VPN 뒤에서 운영하세요.**
- WebSocket 없음: 브라우저는 10초 간격 `changes?since=<version>` 폴링(변화 없으면 304).
- 에이전트(Claude 세션)는 같은 REST API를 폴링해 코멘트를 플랜에 반영합니다.

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
| `ROOM_ALLOWED_ORIGINS` | `*` | CORS 허용 origin (콤마 구분) |
| `ROOM_PUBLIC_URL` | 요청 origin | 방 생성 응답의 공유 링크 base URL |

## Railway 배포

1. 이 fork를 GitHub에 push한다.
2. Railway → New Project → **Deploy from GitHub repo** → 이 저장소 선택.
   - repo 루트의 `railway.json`이 `apps/room/Dockerfile`로 빌드를 지정한다.
3. **Postgres 추가**: 프로젝트에 PostgreSQL 서비스 추가 → room 서비스 Variables에서 `DATABASE_URL`을 Postgres의 `DATABASE_URL` 참조(`${{Postgres.DATABASE_URL}}`)로 연결한다.
   - Postgres 없이 쓰려면 Volume을 붙이고 `ROOM_DATA_DIR`을 볼륨 경로로 지정한다 (Railway 파일시스템은 기본 휘발성).
4. (권장) `ROOM_PUBLIC_URL`에 Railway가 준 도메인을 설정한다.
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
