# workspace

Ten repo/npm/image: `n24q02m/workspace` / `@n24q02m/workspace` / `n24q02m/workspace` (truoc day la `better-workspace-mcp`). CON GIU ten cu co chu dich: registry id `io.github.n24q02m/better-workspace-mcp`, bin alias `better-workspace-mcp`, skret path `/better-workspace-mcp/prod`, va path `.private/superpower/better-workspace-mcp/...`. Data dir la `~/.better-workspace/` (hull derive tu `STORE_PLUGIN`); `~/.better-workspace-mcp` cu chi doc lam fallback.

TypeScript MCP Server cho Google Workspace (Docs/Drive/Calendar/Gmail/Sheets/Slides/Tasks/Chat/People/Forms + multi-account). Kien truc: vendored-services (Apache-2.0 code tu gemini-cli-extensions/workspace duoi `src/vendored/services/`, gan byte-identical upstream — 2 file da fork co chu dich, xem `NOTICE`) + service CUA MINH duoi `src/services/` (upstream khong co) + hull adapter (`@n24q02m/hull`, auth + credential storage + HTTP transport). N+2 tools: 1 composite tool per service (docs, drive, calendar, chat, gmail, slides, sheets, tasks, people, time, forms) + `config` + `help`.

Trang thai: M2 multi-account COMPLETE (Task 9 smoke that voi 2 Google account da PASS 2026-07-25 — xem `.private/superpower/better-workspace-mcp/m2-task9-live-smoke-2026-07-25.md`). M3 Task 1 (sub-keying) da tren main. Stdio server voi 11 domain (docs/drive/calendar/chat/gmail/slides/sheets/tasks/people/time/forms) + `config` + `help`, hull Desktop OAuth loopback (redirect + access_type=offline -> refresh_token), N+2 registry derive tu `src/tools/domains/index.ts` (DOMAINS list) + `makeDomainRun` factory. Moi domain tool nhan `account="<email>"` (khong truyen = primary); `config` them 4 action `account_add`/`account_list`/`account_remove`/`account_set_default`. Test count va coverage o dong nay la so lieu cu, chua doi chieu sau khi cutover sang hull. Chay tren Windows ra so KHAC vai phan muoi (98.32/95.24/98.7/98.7) vi mot so nhanh phu thuoc platform — lech nho giua local va CI la binh thuong, KHONG phai dau hieu hong. M1 da validated live real Google (docs create+read + 6 domain read). M5 packaging: compose overlay + `scripts/sync-upstream.mjs` DA co; con lai la release cascade (BETA → Test B → STABLE) + trang tren mcp.n24q02m.com.

## Vendored boundary

`src/vendored/services/*` + pure-logic utils (`IdUtils/validation/GaxiosConfig/DriveQueryBuilder/MimeHelper/constants`) la Apache-2.0 upstream code tu gemini-cli-extensions/workspace. Giu GIONG upstream de con SYNC duoc cap nhat cua Google ve — do la ly do duy nhat, khong phai muc tieu tu than. Gap bug o day thi SUA NGAY tai repo nay, roi ghi file da fork vao `NOTICE` de lan sync sau bao conflict thay vi ghi de im lang; PR-back len upstream KHONG phai viec cua repo nay. Da fork co chu dich: `MimeHelper.ts` (boundary suy bien), `SheetsService.ts` (N call -> batchGet + fallback). `paths.ts`/`logger.ts`/`auth/AuthManager.ts` la SHIM cua minh (infra decoupled khoi gemini-cli). **Service ma upstream KHONG co thi dat `src/services/`, KHONG dat trong `src/vendored/`** (`FormsService.ts` la case dau tien): nhet code minh vao vung vendored se lam lan sync sau bao conflict o mot file upstream chua tung co. Viet theo hinh dang service vendored (constructor nhan AuthManager, private client getter, arrow-fn property) nhung theo style adapter — biome KHONG bo qua `src/services/**`, va coverage gate CO tinh no. biome + tsc-strict deu handle qua override (`biome.json` bo lint VA format `src/vendored/{services,utils}/**` — nen file trong do khong duoc biome kiem, phai tu khop style cua chinh file do: vendored dung dau `;`, khac code adapter). Xem `NOTICE`.

## Sync upstream

```bash
node scripts/sync-upstream.mjs --ref main --dry-run   # xem truoc, khong ghi gi
node scripts/sync-upstream.mjs --ref v0.0.8           # ghi + chay `bun run test`
```

Chay TAY theo chu ky, KHONG wire vao CI (sync = ghi de code chua ai review trong PR cua repo nay; pipeline xanh ma tu di chuyen code vendored la dung cai nguoc lai voi ly do `src/vendored/**` ton tai). Script doc HAI danh sach trong `NOTICE` lam nguon su that — file da fork (bao CONFLICT, KHONG ghi) va file shim trung ten voi upstream (bo qua han). `NOTICE` hong/rong → script TU CHOI chay, vi list rong se doc thanh "khong file nao duoc bao ve".

Verified 2026-07-27: `--ref main` cho 15/15 file non-fork **byte-identical** + dung 2 CONFLICT (`SheetsService.ts`, `MimeHelper.ts`) → vendored tree dang khop upstream main, va list trong `NOTICE` dung du. `--ref v0.0.8` cho 4 changed + `TasksService.ts` GONE (service them sau tag do) — tuc repo vendor tu `main`, khong tu tag.

**Bay Windows da tra gia**: temp clone cua upstream KHONG co `.gitattributes`, ma `core.autocrlf=true` nam o system gitconfig → checkout ra CRLF, so voi LF cua repo nay thi MOI file deu "changed" (dry run dau tien bao 14 changed trong khi upstream khong doi gi). Script tu set `core.autocrlf=false` + `core.eol=lf` cho temp clone. Dung bo hai dong do.

## Modes

DUNG HAI mode, chon o `main.ts:getTransportMode` — `stdio` (mac dinh) va `http` (`--http` | `MCP_TRANSPORT=http` | `TRANSPORT_MODE=http`). **KHONG co `stdio proxy`**: cac server khac trong stack (notion/email/wet) chay `runSmartStdioProxy` — stdio pipe boc mot daemon HTTP ben trong — con repo nay noi `StdioServerTransport` THANG (`main.ts:87`), khong co daemon hop. Dung viet "stdio proxy" vao tai lieu/mode-matrix cua repo nay.

- **stdio**: single-user. Credential KHONG den tu env — env chi mang OAuth client id/secret; token that do `runOAuthSetup` lay ve qua consent lan dau (loopback) roi luu ma hoa vao `~/.better-workspace/config.json` (hull `PerPluginStore`, khoa machine-bound o `.secret`). Ban cu `~/.better-workspace-mcp/` duoc doc lam fallback. Lan chay sau resolve thang ve `configured`.
- **http**: multi-user, bearer token qua hull `multi` auth (`WORKSPACE_USERS_FILE`). Moi namespace mot bucket credential (`PerPluginStore` voi subject, khoa scrypt derive tu `CREDENTIAL_SECRET`). Khong co Google OAuth tren HTTP; consent chay tren host qua `workspace auth --user <namespace>`. Request khong co bearer hop le bi tu choi (fail closed).

`account_add` tu chon duong di theo `currentSubject()`: co subject (HTTP) thi tra lenh `workspace auth --user <sub>` de chay tren host; khong co (stdio) thi dung server tam tren loopback. Xem Multi-account.

### Env cua http mode

| Bien | Bat buoc | Vai tro |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | co | Web client (compose map tu `GOOGLE_OAUTH_WEB_*`). |
| `CREDENTIAL_SECRET` | co | Khoa derive credential store cua tung namespace. Thieu no thi `startHttp` nem ngay o startup. |
| `WORKSPACE_USERS_FILE` | co | File users cua hull `multi` auth: bearer token → namespace. |
| `HOST` / `PORT` | khong | `PORT` mac dinh `0` (OS cap). `HOST` mac dinh loopback cua hull → container PHAI `0.0.0.0`. |

Credential luu tren dia container (volume) tai `~/.better-workspace/`.

### Hai OAuth client, khong phai mot

Google rang buoc redirect URI theo **loai client**: Desktop redirect duoc toi loopback port bat ky (dung cho stdio), Web chi redirect toi URI dang ky truoc. Nen stdio va http la HAI client khac nhau, hai secret khac nhau.

**Chua verify:** consent `workspace auth --user` tren host dung loopback port ngau nhien (`startLoopbackConsent`, port 0). Voi Web client, redirect URI phai nam trong danh sach dang ky; neu khong khop Google tra `redirect_uri_mismatch`. Can xac nhan truoc khi tin flow HTTP.

Ghi de `GOOGLE_OAUTH_CLIENT_ID/_SECRET` bang gia tri Web se lam dut moi ban stdio dang chay. Vi the skret `/better-workspace-mcp/prod` giu HAI cap ten khac nhau (`GOOGLE_OAUTH_*` = Desktop, `GOOGLE_OAUTH_WEB_*` = Web), va `docker-compose.http.yml` doi ten `GOOGLE_OAUTH_WEB_*` → ten tran khi bom vao container — server chi doc `GOOGLE_OAUTH_CLIENT_ID/_SECRET`.

## Multi-account

- Nhieu account nam trong MOT blob ma hoa cua `PerPluginStore` — shape v2 `{version: 2, accounts: {<email>: record}, primary: <email>}` (`src/auth/account-store.ts`). KHONG phai key-per-account: `PerPluginStore` chi co DUNG MOT credKey moi cap (plugin, sub) (`per-plugin-store.ts:74-82`), nen layout `subs/<sub>/accounts/<email>/token` ma spec §4.2 ve khong dung duoc. Ke thua uu diem: ghi mot blob la atomic, `accounts` va `primary` khong bao gio lech nhau.
- Account cua tung request di qua `AsyncLocalStorage` (`src/auth/account-context.ts`), KHONG qua tham so: service vendored la singleton khoi tao luc module-load (`src/tools/domains/factory.ts`) va chu ky upstream `getAuthenticatedClient()` khong nhan tham so — giu nguyen chu ky do chinh la giu vendored boundary. Shim `src/vendored/auth/AuthManager.ts` doc `currentAccount()` roi chuyen xuong `WorkspaceAuth`.
- `getAuthenticatedClient(account?)` dung `OAuth2Client` MOI moi lan goi. KHONG cache client: closure cua listener `'tokens'` giu snapshot record cu, va cache dung chung giua cac account = loi isolation credential. Giu merge order `{...record, ...t}` (google-auth-library khong kem refresh_token khi refresh).
- Goi tool voi account la = LOI co ten account do + liet ke account da cau hinh. KHONG am tham roi ve primary (se hanh dong tren sai mailbox).
- `account_add` co HAI duong, chon theo `currentSubject()`:
  - **stdio** (`src/auth/add-account.ts`): `startLoopbackConsent` tren loopback, tra URL ngay, TTL 10 phut. Nhan `value="primary"`.
  - **http** (`src/auth/cli-auth.ts`): server KHONG phuc vu consent qua HTTP. Tool tra lenh `workspace auth --user <sub>` de nguoi van hanh chay tren host; consent xong ghi credential vao bucket cua namespace do. Doi default bang `account_set_default`.
- Nang tu M1 (blob phang): server tu nhan ve (adopt) khi suy duoc email tu `id_token` — offline, la case thuong gap vi M1 xin `openid`+`email` va luu ca token response. Neu khong suy duoc thi hoi Google userinfo (CAN MANG). Ca hai that bai: state ve `awaiting_setup`, server mo OAuth, va lan consent DO GHI DUOC — `put(..., {absorbLegacy: true})` mang blob cu sang key `UNIDENTIFIED_ACCOUNT = '(unidentified)'` thay vi de len no. Account vua consent thanh primary; `(unidentified)` hien o `account_list`, xoa duoc bang `account_remove`, va `remove()` KHONG de no len primary khi con account thuc. Da viet ro trong README + `src/docs/config.md`.
- Guard cua `put()` VAN nguyen tac dung cho duong goi truc tiep khong kem `absorbLegacy` (test khang dinh ca hai chieu). Chi `WorkspaceAuth.saveTokens` truyen co do — moi caller ngoai cua no (`runOAuthSetup`, `startAddAccount`) dung sau mot lan consent nguoi dung vua hoan tat. **Ly do co nay ton tai**: khong co no thi guard chan chinh lan ghi cua consent → startup fail, ma `setup_reset` lai can server dang chay = trang thai khong thoat duoc bang cong cu trong san pham (chi con xoa tay `~/.better-workspace-mcp/config.json`). Them guard thi phai hoi: duong PHUC HOI co di qua chinh cai vua chan khong?
- Scope Forms (`forms.body`, `forms.responses.readonly`) da xin san o M2 nen M4 KHONG them scope nao. **DINH CHINH M4**: canh bao "account cap quyen truoc M2 PHAI re-consent" (ghi o note M2 + README cu) la NOI QUA. Doc Google liet ke `https://www.googleapis.com/auth/drive` la scope THAY THE hop le cho CA NAM method Forms ta goi (create/get/batchUpdate + responses.list/get), ma `drive` co trong `WORKSPACE_SCOPES` tu commit OAuth dau tien `f1ef0d1` (2026-07-17), truoc khi them `forms.body` o `b411175` (2026-07-25). Nen account cu van chay. Chi dinh 403 `Request had insufficient authentication scopes` neu grant khong co CA `drive` LAN forms.* (Google cho user bo tick tung restricted scope). Chua bang `config(action="account_add")` dang nhap DUNG account do (`prompt=consent` nen consent screen luon hien, va `AccountStore.put` ghi de record cu tai cho — khong can `account_remove` truoc). Chua verify live (can smoke that voi token pre-M2); doc theo tai lieu Google, khong theo test.

## Lenh thuong dung

```bash
bun install
bun run check       # biome check . + tsc --noEmit (CI command)
bun run check:fix   # auto-fix biome + type-check
bun run test        # vitest
bun run test:coverage  # vitest --coverage (enforce threshold 95/95/90/95)
bun run build       # tsc -build + scripts/build-cli.js -> bin/cli.mjs
```

## Cau hinh

- License: Apache-2.0 (repo nay vendor code Apache-2.0 tu upstream; ca stack deu Apache-2.0).
- Compose: `docker-compose.yml` (base, target `stdio`) + `docker-compose.http.yml` (overlay, target `http`). Build tu Dockerfile local voi `target:` chu KHONG pull theo tag — CD build KHONG truyen `target` nen moi tag da publish deu la stage CUOI cua Dockerfile (= `http`), khong co tag `:stdio`. Volume tro vao `/home/node/.better-workspace` (thu muc hull ghi PerPluginStore; `~/.better-workspace-mcp` cu chi doc lam fallback), KHONG phai `/data` nhu notion/email (o do volume /data khong che duong ghi nao). Port o overlay = 8087 (notion+telegram 8081, email 8082, imagine 8084, wet 8085, mnemo 8086), publish CHI tren loopback host (`127.0.0.1:8087`); muon dung ngoai may thi dat TLS reverse proxy cua minh tren cung host. Repo KHONG van hanh hosted endpoint nao: duong ho tro = stdio + self-host http qua overlay nay.
- `type-check` = `tsc --noEmit` (mot pass, types node).
- Test surface: 378 test / 25 file = unit + component + 2 hermetic protocol E2E (`tests/protocol/m1-stdio.test.ts`, `tests/protocol/m2-multi-account.test.ts` — stdio_client spawn bin/cli.mjs, seeded token, no real network). Real-Google smoke = thu cong (manual, ngoai CI — can OAuth client + consent). Smoke 2 account cua M2 DA CHAY 2026-07-25, 6/6 buoc PASS: M1 flat blob -> v2 adopt offline giu nguyen `refresh_token`; account thu 2 them qua `account_add`; `getMe` tra 2 danh tinh khac nhau; `drive.search` tra data khac nhau theo account; account la truyen vao bi tu choi DUNG TEN (khong am tham fallback ve primary); force-expire refresh chi cap nhat account B, token account A byte-identical. Chi tiet + cach tai hien: `.private/superpower/better-workspace-mcp/m2-task9-live-smoke-2026-07-25.md`.

## Dependency dac biet

`@n24q02m/hull` ^0.4.0 thay cho package nen MCP cu (da retire). Hull cung cap `runHttpServer` (auth `multi`, bearer qua `WORKSPACE_USERS_FILE`), `PerPluginStore`, `runWithAuthContext`/`currentUser`, va `buildCli` (lenh `auth` = `authCommand` trong `src/auth/cli-auth.ts`).

