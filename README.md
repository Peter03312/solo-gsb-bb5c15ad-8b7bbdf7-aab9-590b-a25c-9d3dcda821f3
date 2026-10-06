# 联排提示板（Rehearsal CueBoard）

为剧场联排制作的 Web 提示板：舞监（Stage Manager）在草稿中录入提示项的计划开始时间、时长、负责岗位与前置关系，校验通过后发布**只读联排版本**；灯光 / 音响 / 道具等执行岗位在现场页面只登记**本岗位**提示项的实际开始、完成或预计结束时间，系统依据前置项的实际/预计结束自动重算未开始项，并展示顺延导致的岗位冲突。

- 后端：Node.js + Express + better-sqlite3（SQLite，同步事务）
- 前端：浏览器原生 HTML/CSS/JavaScript（无需构建）
- 本地账号体系：服务端 Session 登录，区分**舞监**与**执行岗位**
- 打包：Dockerfile + Docker Compose 一键启动（自动安装依赖、初始化数据）

## 一、快速启动（推荐，Docker 一键）

要求已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

启动过程会自动完成：

1. 构建镜像并安装 npm 依赖（含 better-sqlite3）；
2. 初始化 SQLite 数据库：建表、创建默认账号、写入一份可直接发布的示例草稿；
3. 在容器内启动 Web 服务。

浏览器访问：

> **http://localhost:3000**

如宿主机 3000 端口被占用，可指定其他端口：

```bash
PORT=8080 docker compose up --build -d
# 访问 http://localhost:8080
```

停止与查看日志：

```bash
docker compose logs -f
docker compose down            # 停止并移除容器（保留数据卷）
docker compose down -v         # 同时删除数据库数据卷（恢复出厂）
```

数据库文件持久化在 Docker 卷 `cueboard-data`（容器内 `/app/data/cueboard.db`）。

## 二、本地直接运行（无需 Docker）

要求 Node.js ≥ 18（推荐 20）。

```bash
npm install
npm run initdb     # 首次运行：建表 + 播种（重复执行安全、幂等）
npm start
```

浏览器访问 **http://localhost:3000**。

## 三、默认账号

首次启动自动创建（请在生产环境及时更改代码/重新播种密码）：

| 角色 | 用户名 | 密码 | 说明 |
| --- | --- | --- | --- |
| 舞监 | `sm` | `sm12345` | 草稿增删改、发布版本、查看全部 |
| 灯光执行 | `light` | `light123` | 仅可登记「灯光」岗位提示项 |
| 音响执行 | `sound` | `sound123` | 仅可登记「音响」岗位提示项 |
| 道具执行 | `props` | `props123` | 仅可登记「道具」岗位提示项 |

## 四、使用说明

### 舞监

1. **草稿编辑**页新增提示项：编号、岗位、计划开始（HH:MM）、时长（分钟）、说明；
2. 在「前置关系」区为提示项指定「某提示项完成后 → 本提示项」，可构成多前置链；
3. 页面实时显示校验结果。满足以下全部条件时才可发布：
   - 每个前置项的**计划结束 ≤ 后项计划开始**；
   - **同一岗位**的计划时段不重叠（首尾相接允许）；
   - 前置依赖**无环**；
   - **共享资源**在任一计划半开时段的累计占用不超过其容量（见下节「联排共享资源」）；
   - 失败时明确列出每一项冲突（冲突双方、岗位、时间、环路径；资源冲突列明资源、超额时段与相关提示项）；
4. 点击「发布联排版本」生成只读版本，现场随即以该版本为准；草稿可继续修改并发布新版本。

#### 联排共享资源（本轮新增）

联排中容量有限、可被多个提示项**同时占用**的设施（如无线麦、升降台、追光位、同一件道具）可登记为**共享资源**，由舞监在草稿页「联排共享资源」面板配置：

1. **草稿配置**：新增资源时填写**名称（≤50 字、草稿内唯一）与正整数容量**；容量与名称可随时修改（仍校验正整数与重名）；
2. **提示项占用**：在新增/编辑提示项表单的「共享资源占用」区为每个资源填写**正整数占用量**（留空表示不占用，如某提示项使用 2 支无线麦则填 2）；
3. **引用保护**：**仍被任一提示项引用的资源不能删除**（删除按钮禁用，强删接口返回 409 `RESOURCE_IN_USE` 并逐项列出引用提示项）；先把相关提示项的占用清空（保存一次）后才能删除；
4. **草稿校验（阻止发布）**：校验按各提示项的**计划半开时段 `[开始, 结束)`** 累计同一资源的占用——首尾相接不算重叠；任一连续时段占用量超过容量即列为 `RESOURCE_OVERLOAD` 错误，**列明资源、容量、超额时段（HH:MM-HH:MM）、占用量/超额量与相关提示项（含各自占用量）**，与既有冲突一起阻止发布（422 `PUBLISH_CONFLICT`）；
5. **发布冻结**：发布时把资源的**名称、容量**与各提示项的占用**随版本冻结**到新版；此后修改草稿中的资源名称/容量/占用**不影响任何已发布版本**，旧版继续按冻结值展示与重算。**旧版没有资源数据时（升级前发布的版本）资源列表与告警均为空，完全沿用原有行为**；
6. **无效输入整体拒绝**：容量或占用量不是正整数（0、负数、小数、非数字）返回 400 `BAD_INPUT` / `RESOURCE_USAGE_INVALID`；提示项引用了已不存在的资源（如旧页面提交）返回 400 `RESOURCE_REF_INVALID`；资源重名返回 400 `RESOURCE_NAME_EXISTS`；携带过期草稿版本号按既有规则返回 409 `VERSION_CONFLICT`——任一不合法均整体拒绝，不写入部分数据。所有资源增删改同样推进草稿版本号，过期页面须刷新后再提交。

**现场（已发布版本）资源超额重算与告警**：现场页在既有「重算开始/结束」（实际、预计与顺延/停排后时段）之上，按冻结的容量与占用重新累计资源占用并给出**只读告警**：

- **跳过项不占用**（状态 `SKIPPED` 的提示项不参与任何资源时段）；
- 时段口径：**已完成项用实际执行时段、已开始未完成项用「实际开始 → 顺延推算/预计结束」、未开始项用顺延后的待执行时段**（与现场重算、停排顺延完全一致）；
- **仅有已完成项构成的超额不告警**（超额窗口的相关提示项中至少有一项是未开始/已开始才展示红条）；
- **告警不阻止登记**：岗位开始/预计/完成、舞监更正、跳过、签认等全部照常办理，资源红条只作现场提示，登记响应中也带最新告警。

**顺延预演**的结果弹窗在既有同岗位冲突对照之外，新增「共享资源超额对照」：以「资源 + 相关提示项集合」为稳定键，按与现场完全一致的口径列出 🔴 **新增**、🟢 **消失**、🟠 **持续**（时段变化时同时给出变更前后消息），顶部汇总「基线 N 项 → 预演 M 项」；预演仍为只读，资源占用与容量都取自冻结版本。

历史版本回看页展示该版**冻结的资源定义**（名称/容量）、每行冻结占用，以及按该版当前重算口径得到的资源告警（只读）。


#### 发布新版前：旧执行版已完成登记交接（本轮新增）

发布面板的「旧执行版登记交接」区会在**发布前自动预览**（也可点击「重新预览」），对照**当前草稿与旧执行版（最新已发布版本）**逐条列出旧版中**已完成**提示项（旧登记同时有实际开始与实际完成）的交接资格：

- **可选条件（同时满足）**：草稿与旧版**同一提示项引用**（即草稿提示项 id）的**编号、说明、岗位、计划开始、时长、前置集合**六项完全一致，且旧登记**同时有实际开始和实际完成**；
- 不满足的项列入「不可选」，逐项注明不合格原因（如「计划开始不一致（旧版 19:12 → 草稿 19:13）」），复选框禁用；
- **无旧版（首次发布）或旧版无已完成项时，列表为空**，不影响正常发布。

舞监勾选要延续的项后点「发布联排版本」：

- 确认发布时服务器在**同一事务内重新核对**：①草稿版本号、②旧执行版（必须仍是当前执行版）、③每个所选登记行的**行版本号**、④资格是否仍成立；任一变化或资格失效则**整体拒绝**（HTTP 409 `HANDOVER_STALE`，响应逐项列出原因），不会产生新版本，请**重新预览**后再发布；
- 成功后**仅将所选项的实际开始、实际完成带入新版**（不延续预计结束、不复制更正历史），**未选项保持空登记**；新版对应行标注「↩ 交接自第 N 版·编号」标明来源版本与提示项；
- **旧版登记与更正历史原样保留、继续可回看**（「发布版本」页回看，含来源标注与更正记录）；已发布计划仍然冻结，交接只影响新版的现场登记初值；
- 未传 `handover` 字段的发布请求**完全维持原行为**（新版全部空登记）；计划冲突仍然阻止发布（422）。

#### 舞监现场更正（仅当前执行版本）

舞监在「现场联排」页可对任一行登记进行**更正**（点击该行「更正」按钮）：

- 一次只能更正或清除**实际开始 / 实际完成 / 预计结束**中的**任意一项**，并必须填写更正原因（≤200 字）；
- 更正**只改变现场登记**，不修改已发布计划（计划开始/时长/前置关系保持冻结）；
- 提交必须携带所见登记行的**行版本号**，且与岗位登记**共用同一版本校验**：岗位或舞监任一方先提交后，另一方持旧版本提交会收到 **409** 并提示刷新，不能覆盖新登记；
- **归档版本（已有更新版本发布）禁止更正**，现场页对应行显示「归档不可更正」；
- 联动约束（不满足则整体拒绝，不写入任何部分更正与历史）：
  - 更正后的实际完成必须有实际开始，且不得早于实际开始；
  - 清除实际开始时系统**同时清除实际完成**（级联清除，历史中标注「级联清除」）；
  - 保留的预计结束不得早于实际开始；若无实际开始则不得早于原计划开始；
  - 无变化的提交（前后值相同）视为无效。
- 更正成功后按现有规则**重算后续未开始项与同岗位冲突**（顺延不早于原计划，冲突在红条展示）；
- 每次更正都记录**更正项、更正前/更正后值、操作者、时间、原因**；点击行内「更正记录(N)」可回看，历史版本回看页中也可查看（只读）。

#### 现场岗位代班（本轮新增）

现场临时换人时，舞监在「现场联排」页的「岗位代班」面板为**当前执行版**的某个岗位指定一名**已有执行账号**代班：

- **启用 / 撤销**：选择岗位与执行账号后「启用代班」；在任代班行点「撤销」恢复原岗位账号。每次变更都记录**操作者与时间**（启用/撤销各一条），面板与「发布版本」回看页均可查看；
- **每个版本每个岗位至多一名在任代班**：重复启用返回 409 `DEPUTY_EXISTS`，需先撤销再启用；重复撤销返回 409 `NO_ACTIVE_DEPUTY`；
- **权限转移**：代班期间**原岗位账号失去该岗位登记权**（提交返回 403 `DEPUTY_ACTIVE`），**代班账号获得该岗位登记权且保留自己原有岗位权限**；撤销后原岗位账号立即恢复，代班账号持旧页面提交会被 403 拒绝且**不改动任何登记**；
- **仅当前执行版可变更**：启用/撤销只作用于当前执行版；**发布新版后代班不自动延续**（新版无代班），旧版代班记录在回看页**只读可查**；
- **明确报错不留部分记录**：未知账号（404 `UNKNOWN_ACCOUNT`）、非执行账号（400 `NOT_OPERATOR`）、当前版没有的岗位（400 `POSITION_NOT_IN_VERSION`）、页面版本过期（409 `VERSION_STALE`）均整体拒绝；
- 登记提交在**同一事务内**复核当前执行版、代班授权与登记行版本，原有登记请求响应、行版本冲突（409）与时间校验保持兼容。

#### 依赖链跳过（本轮新增）

联排中某项无法执行时，舞监在「现场联排」页点该行「跳过链…」，对**当前执行版**发起跳过：

1. **影响预览**：系统以该项为根，沿已发布的前置关系（from → to）求出**根项及全部可达后继**，以拓扑序列出整条依赖链，逐项展示编号、岗位、计划时段、登记行版本号与当前状态；
2. **填写非空原因并确认**：原因必填（≤200 字）。确认后将整条依赖链标记为跳过；
3. **阻断与原子性**：链中任一项（尚未跳过的）**已有实际开始或实际完成**，或**预览所见的登记行版本在确认时已变化**，整次操作**整体拒绝**并列出阻断项（409 `SKIP_BLOCKED` / 409 `VERSION_CONFLICT`，响应逐项给出编号、当前行版本与原因），**不留任何部分标记**；提交的链范围必须与当前版本的闭包完全一致（400 `CHAIN_MISMATCH`），请重新预览后再确认；
4. **首次跳过的效果**：清除该项的**预计结束**，**保留已发布计划**（计划开始/时长/前置关系冻结不变），并对每个新跳过项记录**操作者（舞监）、时间、原因及触发根项**；
5. **已跳过项只展示、不重复留痕**：已跳过项再次出现在链中（或以其为根重新操作）时只在预览中展示其既有原因，确认不会写入第二条留痕、行版本也不再变化；
6. **跳过即终态**：执行账号对跳过项提交登记返回 409 `CUE_SKIPPED`；舞监对跳过项提交更正同样返回 409 `CUE_SKIPPED`（**不得更正其时间**，跳过清除的预计结束也不能通过更正恢复）；
7. **现场重算规则**：跳过项状态为 `SKIPPED`，**不计入待执行时段**（无重算开始/结束）、**不参与同岗位冲突**，且**不把自己的结束作为后继项的前置约束**（后继只受未跳过前置的实际/预计结束约束），其他项仍按现有前置与登记规则重算；
8. **版本边界**：**仅当前执行版**可预览与确认（携带 `versionId` 时旧版返回 409 `VERSION_STALE`）；**新发布版不继承跳过状态**（新版全部为空登记）；**旧版回看可见**每行跳过原因、操作者、时间与触发根项；已完成项的交接资格沿用现有约定（跳过项因不可能同时具备实际开始与完成，不进入交接候选）。

页面上：跳过行以紫色「已跳过」徽标与置灰底色展示，重算时段与实际/预计时间列显示「—」，实际开始列附跳过原因标签；舞监可点「跳过原因」回看详情；版本列表新增「已跳过」计数；执行账号的现场页对跳过项只读且无登记按钮。

#### 现场顺延预演（本轮新增）

现场发生顺延时，舞监在「现场联排」页点「**填写假设并重算预演…**」（或在某行点「**顺延预演**」直接预填该行），对**当前执行版**的一项或多项**未完成、未跳过**提示项填写**假设预计结束时间**，查看变更前后差异：

- **同时套用、一次重算**：预演以**同一次读取的当前执行版与全部登记行快照**为基线，把全部假设**一次性**套用后，按现有前置顺延与跳过规则重算（不是逐条串行试算），因此同批假设之间的联动（如前置项也被假设）会正确传导；重算开始仍不早于原计划，跳过项仍不计入待执行时段与冲突；
- **逐项差异**：结果弹窗逐行列出原计划时段、**变更前（基线）待执行开始/结束**、**变更后（预演）待执行开始/结束**及开始/结束的分钟差（推迟红色、回缩绿色），假设项有蓝色标记；
- **冲突对照**：同岗位冲突按「岗位 + 双方提示项」稳定配对，分为**🔴 新增、🟢 消失、🟠 仍存在**（仍存在且时段变化时同时给出变更前后消息），顶部汇总「基线 N 项 → 预演 M 项」；
- **假设边界（不满足整体拒绝，逐项给出原因，HTTP 400 `WHATIF_INVALID`）**：
  - 仅**未开始 / 已开始（RUNNING）且未完成、未跳过**项可假设；**已完成、已跳过项明确拒绝**；
  - **已开始项**的假设预计结束**不得早于实际开始**；
  - **未开始项**不得早于**预演算出的开始**（按全部假设套用后的开始计算，而不是基线开始）；
  - **无效时间**（非 HH:MM）、**重复项**（同一 cueRef 出现两次）明确拒绝；
- **一致读取，拒绝混合时点**：请求必须携带**所见版本 `versionId` 与全部提示项登记行版本 `rows[]`**。服务端在同一事务内核对：版本已归档（409 `VERSION_STALE`）、登记行数量/引用不一致、任一登记行版本已变化（409 `WHATIF_STALE`，逐项列出当前版本）均**整体拒绝**，请刷新页面后重新预演，绝不返回混合时点结果；
- **只读**：预演**不更改任何登记、已发布计划、跳过状态与更正历史**，也不推进任何行版本；结果页可点「调整假设重新预演」反复试算；如需落实，仍由岗位按既有流程登记或由舞监更正；
- 仅**舞监**可调用（执行账号 403）；仅**当前执行版**可预演；也可通过 HTTP API `POST /api/live/whatif` 获取与页面完全同等的结果（见第十二节示例）。

#### 排期来源解释（本轮新增）

现场发现某提示项顺延时，舞监与执行岗位都可在「现场联排」页（当前执行版）或「发布版本」回看页（历史版本）点该行的「**来源**」按钮，查看其**排期开始时刻如何形成**：

- 解释以该项**原计划开始为基线**，列出所有**达到最终最大约束时刻的直接前置**；同一最大时刻由多条路径共同决定时**全部展示**，不任意只取一条；
- 沿**尚未开始的前置**逐层追溯其来源，每步标明结束时刻取自**实际完成**、**预计结束**还是**按时长推算**（实际/重算开始 + 时长）；
- **已跳过前置不构成约束**（单独标注，含跳过原因）；**原计划本身决定开始**时明确显示「无需顺延」（前置结束恰与原计划同刻到达时也会注明）；
- 解释与**同一版本的现场重算结果一致**：登记、更正或跳过后刷新页面即可看到最新解释；历史版本按归档状态**只读回看**；
- 目标为**已开始 / 已完成 / 已跳过**项时给出明确说明（无待解释的排期开始）；目标或版本不存在时返回 404；查询为只读，**不改动登记与已发布计划**。

### 联排中断：停排 / 恢复（本轮新增）

联排因故中断时，舞监在「现场联排」页的「**联排中断**」面板为**当前执行版**登记停排，恢复时再登记恢复：

1. **停排**：填写当日 **HH:MM 停排时刻 + 非空原因**（≤200 字）。同一版本**只能有一段进行中的停排**（重复停排返回 409 `INTERRUPTION_EXISTS`）；时刻必须**严格递增**（晚于最近一次恢复时刻），且**不得覆盖任何已登记的实际开始 / 实际完成**（逐项列出冲突，整体拒绝 400 `INTERRUPTION_TIME_CONFLICT`）；
2. **停排生效时（同一事务，失败不留部分记录）**：
   - 全部**未开始、未跳过**项的**原预计结束被清除**，对应登记行**行版本 +1**，并在更正历史留痕（原因注明停排时刻与原因）；
   - **停排前的有效双签（执行人就绪 + 舞监可执行）整体失效并保留失效原因**，恢复后**须双方重签**才能登记开始；
   - **执行账号**的开始 / 预计结束 / 完成登记与**新签认一律拒绝**（409 `INTERRUPTION_ACTIVE`），**发布新版也须先恢复**（409 `INTERRUPTION_ACTIVE`）；
   - **舞监更正、依赖链跳过仍可办理**；但**更正后的实际开始 / 实际完成不得落入任何停排区间**（半开 `[停排, 恢复)`，400 `INTERRUPTION_TIME_CONFLICT`）；
3. **恢复**：填写严格晚于停排时刻的 **HH:MM 恢复时刻**（重复恢复 409 `NO_ACTIVE_INTERRUPTION`；恢复时刻同样不得覆盖已登记实际时刻）。恢复**不改写任何实际登记时间**，而是按规则重算：
   - **未开始项**重算开始**不得早于最近恢复时刻**（停排进行中则暂以本次停排时刻为最早开始），其被清除的预计结束**不自动恢复**；
   - **已开始未完成项**的**按时长推算结束**与**停排前填写的预计结束****顺延实际开始之后各段中断的整段分钟**，且**不得早于最近恢复时刻**；实际开始时间保持不变；
   - 前置依赖顺延与**同岗位冲突同步更新**；
4. **多段停排**：恢复后可再次停排，各段时刻严格递增；已开始项结束按实际开始之后的各段中断累计顺延；
5. **记录留存**：每段停排的时刻、原因、分钟数、停排/恢复操作者与时间都随版本保存，「发布版本」回看页只读可查；版本列表显示停排段数（进行中特别标注）；**新发布版不继承停排状态**（新版无停排）；
6. 现场页顶部显示**停排状态横幅**（停排中 / 已恢复），表格对受影响行标注「⏸ 不早于 HH:MM」（未开始项托底）与「⏸ 中断顺延 N 分」（已开始项结束），「来源」解释同样包含中断顺延与恢复托底说明。

仅**当前执行版**可停排/恢复（携带过期 `versionId` 返回 409 `VERSION_ARCHIVED`）；时间格式错误、原因空等返回 400 `BAD_INPUT`。也可通过 HTTP API `POST /api/live/interruptions` 与 `POST /api/live/interruptions/resume` 办理（见第十四节示例）。

#### 执行版复盘预览与封存（本轮新增）

舞监在「现场联排」页点「**查看复盘预览…**」（复盘面板），对**当前执行版**按**冻结计划、现场登记与停排记录**逐项复盘：

1. **逐项明细**：状态分别标识为**本版完成 / ↩ 交接自旧版完成 / 进行中 / 未开始 / 已跳过**；每个完成项列出：
   - **开始偏差（有符号分钟）**＝实际开始 − 计划开始（正数晚开始、负数提前）；
   - **实际持续分钟**＝实际完成 − 实际开始；
   - **净执行分钟**＝实际持续 − 停排扣除分钟；
   - **停排扣除**只计算「**实际起止区间**」与「**已结束停排段**」（半开 `[停排, 恢复)`）的交集；多段停排的重叠分钟**先求并集只扣一次**；进行中的停排尚未结束、不扣；恰在恢复时刻开始/结束的分钟按半开区间不扣；
2. **不计入汇总的项**：**交接自旧版的完成项**（明细照列其偏差/持续，但净执行列显示「—」并标注来源版本）、**进行中、未开始、已跳过**均**不计入本版已完成汇总**；这四类项的**实际持续与净执行分钟为空**；
3. **按岗位汇总**：仅统计本版完成项的**完成数、净执行分钟与开始偏差之和**，并给出本版合计与五类状态的计数；
4. **预览随登记更新**：舞监**更正登记**或**恢复联排**后重新打开预览（或重新拉取）即得到最新明细；预览本身只读，不改动任何数据；
5. **封存（每版一次）**：确认无误后填写可选备注并点「封存复盘」。浏览器把**预览所见的执行版 id、全部登记行版本与停排状态（已结束停排段 + 是否进行中）**作为依据一并提交，服务端在**同一事务内重新核对**：
   - 执行版已被新版替代 → 409 `REVIEW_VERSION_STALE`（归档版不能封存，只能回看其已有快照）；
   - 任一登记行版本已推进（岗位登记、舞监更正、跳过、停排清除预计结束等）或登记行集合变化 → 409 `REVIEW_BASIS_STALE`，响应逐项列出当前行版本；
   - 停排段新增、恢复时刻变化、预览后进入/结束停排 → 409 `REVIEW_BASIS_STALE`，逐项说明；
   - 缺依据 / 依据格式错误 → 400 `BAD_INPUT`；
   - 任一依据变化均**整体拒绝**，不会写入快照；
6. **封存后的不可变性**：封存成功后，**逐项明细与岗位汇总作为当时快照整体保存**（含操作者与时间）；**此后登记更正、发布交接或发布新版都不得改写该快照**；该版重复封存返回 409 `REVIEW_ALREADY_SEALED`；封存后舞监仍可按现有规则更正本版登记（实时明细会变，快照不变）；
7. **历史版回看**：「发布版本」页每版新增「复盘」列与按钮，舞监可回看任意一版的**实时明细**与**已封存快照**（未封存时只显示实时明细并注明）；版本列表以 🔒 标出已封存版本及封存时间；
8. **权限与无版本**：复盘预览 / 封存 / 历史回看**仅舞监**可调用（未登录 401，执行账号 403）；尚未发布任何版本时预览返回 409 `NO_LIVE_VERSION`，版本不存在时回看返回 404。

也可通过 HTTP API 办理（见第十五节示例）：`GET /api/live/review`、`POST /api/live/review/seal`、`GET /api/versions/:id/review`。

#### 双人放行签认（本轮新增）

联排中有些提示项必须经**舞监与当班执行人双人放行**后才能开始：

1. **草稿标记，随发布冻结**：舞监在草稿编辑页勾选提示项的「**需放行**」（新增/编辑表单中的复选框，列表中以「需放行」标记展示）。该标记随发布版本**冻结**（已发布版本不受草稿后续修改影响）；**未标记项继续按原流程登记**，不需要任何签认；
2. **两类签认**：当前执行版中，**执行人**（仅能为**自己当下有登记权的岗位**签认，含代班获得的岗位）对未开始的需放行项「**签认就绪**」，**舞监**对需放行项「**签认可执行**」。每次签认记录**签认人、时间及目标与直接前置项的登记行版本**（快照）；签认本身**不推进登记行版本**；
3. **双签齐备才能开始**：两类**有效**签认齐备后，岗位才能登记**实际开始**；**预计结束与完成登记仍遵循现有规则**（不需要签认）。缺签或签认已失效时提交开始返回 **409 `SIGNOFF_MISSING`**（逐项说明缺哪类签认），不写入任何登记；
4. **签认失效**（失效记录与原因保留，可回看）：
   - **目标或任一直接前置项的登记行变化**（岗位登记、舞监更正、跳过推进了行版本）使相关旧签认失效，需重新签认；
   - **代班变更**（启用/撤销）后，**失去该岗位登记权者**的执行人签认失效（舞监签认不受代班影响）；
5. **原子复核**：签认与开始提交均在**同一事务内**复核当前执行版、行版本、权限与签认有效性；版本过期（409 `VERSION_ARCHIVED` / `VERSION_CONFLICT`）、缺签（409 `SIGNOFF_MISSING`）、重复签认（409 `SIGNOFF_EXISTS`）、已开始/已完成（409 `SIGNOFF_STATE`）、已跳过（409 `CUE_SKIPPED`）、未标记需放行（400 `RELEASE_NOT_REQUIRED`）均**明确拒绝且不写入部分结果**；
6. **版本边界**：**新发布版不继承签认**（新版全部未签）；**交接带入的已完成项不追补签认**（已完成项无需再开始）；历史版本通过「发布版本」回看页**只读查看签认记录**（含失效原因）；
7. **现场页展示**：「放行签认」列逐项显示执行人/舞监签认状态（未签认 / 已签认含人名时间 / 已失效含原因）与「双签齐备」标记；需放行项编号旁有「需放行」徽标；执行人的「开始」按钮在双签齐备前禁用并提示，点「签认记录(N)」可回看该项全部签认与失效历史。

### 执行岗位

- 「现场联排」页只能看到当前执行版本，本岗位的行高亮并出现操作按钮：
  - **开始**：登记实际开始（默认取当前时间，可手填 HH:MM）；
  - **完成**：登记实际完成（须先开始，完成时刻不得早于开始）；
  - **预计结束**：未开始或已开始均可登记，不得早于（实际或原计划）开始；
- **代班识别**：若你被指定为某岗位代班，页面顶部黄色横幅提示「你正在代班岗位…」，该岗位行同样高亮并可登记（自己原有岗位权限保留）；若你的岗位被他人代班，横幅提示登记权已移交，本岗位行显示「已由 XX 代班」且不再出现操作按钮；
- 非本岗位提示项只读；对非最新（已归档）版本不能登记；
- **联排停排期间本岗位行显示「⛔ 停排中，暂停登记」**：开始 / 预计结束 / 完成提交均会被拒绝（409），新签认也暂停；恢复联排后排期自动顺延（未开始项不早于恢复时刻），停排前的放行双签已失效，**需双方重新签认**后才能开始需放行项；
- 已完成项保留实际时间不再变化；未开始项按前置链重算，**重算开始不早于原计划**；
- **被舞监标记为跳过的提示项只读展示（紫色「已跳过」），无登记按钮**，跳过项不计入待执行时段与岗位冲突，其后继只按未跳过前置重算；
- 顺延产生的同岗位时段冲突在页面顶部红色横幅逐条展示，同时相关行标注「已顺延」；
- 任一提示项（含非本岗位）都可点「来源」查看其排期开始时刻的来源链（见上节「排期来源解释」）；
- **需放行项须双人放行后才能开始**：本岗位需放行项在双签齐备前「开始」按钮禁用；点「**签认就绪**」提交执行人签认（只能为自己当下有登记权的岗位签认；被代班顶替时不能签认）。目标或任一直接前置项登记行变化、代班变更失去登记权都会使你的签认失效，需重新签认；「放行签认」列实时显示两类签认状态与失效原因；
- 岗位登记可能被舞监按规定更正（见上节），更正与岗位登记共用行版本号，持旧版本提交会被 409 拒绝。

### 已发布版本回看

「发布版本」页列出全部历史版本（版本号、说明、发布时间、登记数量、复盘封存标记），点击「回看」查看该版本冻结的提示项、前置关系与当时/最新的现场重算结果；每行可点「来源」查看该版本下排期开始时刻的来源链（只读，与同一版本重算结果一致）；舞监还可在回看页查看每行的**更正记录**（更正前后值、操作者、时间、原因）与需放行项的**签认记录**（签认人、时间、目标与直接前置行版本快照、失效原因），归档版本为只读、不能更正或签认。舞监点每版的「**复盘**」按钮可回看该版**实时明细与已封存复盘快照**（未封存时仅实时明细）。

### 版本号（乐观锁）规则

- 草稿维护全局**草稿版本号**，页面显示 `vN`。任何编辑、增删依赖、发布都必须携带页面加载时的版本号；他人已修改导致版本号过期时返回 **409** 并明确提示当前版本号，前端自动刷新，需要重新编辑后提交；
- 单条提示项的修改同时校验**行版本号**；
- 现场登记按「提示项行版本号」校验：两位岗位同时操作同一提示项时，先提交者成功，后提交者收到 409 明确报错并刷新；
- **舞监更正与岗位登记共用同一条登记行版本号**：任一方更新后行版本 +1，另一方（或持旧页面重复提交）会收到 409 拒绝并被要求刷新，确保更正不能覆盖新登记、新登记也不能覆盖更正。
- **依赖链跳过同样以链中每项的登记行版本号为乐观锁**：确认必须回传预览所见的每个 `rowVersion`；预览后任一项被登记或更正（行版本推进），整次跳过 409 拒绝；跳过成功后新跳过项行版本 +1（已跳过项不重复更新）。
- **现场顺延预演（只读）在单次事务内同时核对所见执行版与全部提示项登记行版本**：请求必须携带 `versionId` 与 `rows: [{cueRef, rowVersion}]`（全部提示项，一项不能少）；版本已归档、行集合与当前版本不一致、或任一登记行版本已推进，均以 409 `WHATIF_STALE` 整体拒绝并逐项给出当前行版本，不会返回基于混合时点的预演结果；预演不推进任何版本号、不写入数据，可对同一快照反复试算。
- **放行签认以「目标 + 直接前置项登记行版本快照」为一致性基准**：签认提交校验目标登记行版本（过期 409 `VERSION_CONFLICT`）；签认本身**不推进登记行版本**，因此两类签认可先后基于同一行版本完成。此后目标或任一直接前置项的登记行版本推进（岗位登记、舞监更正、跳过）即令相关签认失效；开始提交在同一事务内复核当前执行版、行版本、权限与两类签认有效性，缺签或失效以 409 `SIGNOFF_MISSING` 整体拒绝，不写入部分结果。

## 五、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务监听端口（容器内） |
| `DATA_DIR` | `/app/data`（镜像）/ `./data`（本地） | SQLite 数据库所在目录 |
| `DB_PATH` | `$DATA_DIR/cueboard.db` | 数据库文件完整路径 |
| `SESSION_SECRET` | 开发用默认值 | Session  Cookie 签名密钥，**生产必须修改** |
| `TZ` | `Asia/Shanghai` | 容器时区，影响「取当前时间」登记 |

通过 Compose 修改可在项目根目录创建 `.env`，例如：

```env
PORT=8080
SESSION_SECRET=your-long-random-secret
```

## 六、目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh          # 容器入口：先 initdb 再启动服务
├── package.json
├── src
│   ├── server.js          # Express 路由、权限与版本号校验、发布事务
│   ├── db.js              # SQLite 连接与建表
│   ├── initdb.js          # 幂等初始化：账号 + 示例草稿
│   ├── auth.js            # scrypt 密码哈希
│   └── scheduling.js      # 校验/拓扑环检测/现场重算核心算法
└── public
    ├── index.html
    ├── styles.css
    └── app.js             # 登录、草稿、现场、版本回看三个页面
```

## 七、主要 HTTP API

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/login` `/api/logout` | 公开 | 登录 / 退出 |
| GET | `/api/me` | 公开 | 当前会话与岗位列表 |
| GET | `/api/draft` | 舞监 | 草稿（含实时校验结果、共享资源 `resources` 与各提示项 `resourceUsages`） |
| POST/PUT/DELETE | `/api/draft/cues[/:id]` | 舞监 | 提示项增改删（校验草稿版本号/行版本号；可带 `resources:[{resourceId, usage}]` 正整数占用） |
| POST/PUT/DELETE | `/api/draft/resources[/:id]` | 舞监 | **共享资源**增改删（名称 + 正整数容量；仍被引用的资源删除返回 409 `RESOURCE_IN_USE`；占用非法 400 `RESOURCE_USAGE_INVALID`、失效引用 400 `RESOURCE_REF_INVALID`、重名 400 `RESOURCE_NAME_EXISTS`） |
| POST/DELETE | `/api/draft/deps[/:id]` | 舞监 | 前置关系增删（校验草稿版本号） |
| GET | `/api/publish/handover/preview` | 舞监 | **发布前交接预览**：旧执行版已完成项的交接资格、不合格原因、旧登记行版本；无旧版时列表为空 |
| POST | `/api/publish` | 舞监 | 发布只读版本；冲突返回 422 并列出冲突项（**含 `RESOURCE_OVERLOAD`：资源、超额时段、相关提示项**）；可带 `handover` 交接选择，资格/版本失效返回 409 `HANDOVER_STALE`；**当前执行版停排中须先恢复，否则 409 `INTERRUPTION_ACTIVE`** |
| GET | `/api/live` | 已登录 | 当前最新版本的现场重算结果（含每行更正历史 `corrections`、跳过留痕 `skip`、放行签认 `release`、本版代班记录 `deputies`、**联排中断记录 `interruptions` 与 `activeInterruption`，及每行中断影响 `interrupted/pauseShiftMinutes/pauseHoldText`**；执行账号另含有效岗位 `myPositions`；**另含发布时冻结的共享资源 `resources`、每行 `resourceUsages` 与现场资源超额告警 `resourceAlerts`**） |
| GET | `/api/live/deputies` | 已登录 | 当前执行版代班记录（含已撤销历史）；舞监另返回可选岗位 `positions` 与执行账号 `operators` |
| POST | `/api/live/deputies` | 舞监 | 启用岗位代班（仅当前执行版）；重复启用 409 `DEPUTY_EXISTS`；同事务使失去登记权者的签认失效 |
| POST | `/api/live/deputies/revoke` | 舞监 | 撤销岗位在任代班；无在任代班 409 `NO_ACTIVE_DEPUTY`；同事务使失去登记权者的签认失效 |
| POST | `/api/live/signoffs` | 执行岗位 / 舞监 | **双人放行签认**（仅当前执行版、需放行且未开始项）：`kind=operator` 执行人签认就绪（须当下有该岗位登记权）、`kind=sm` 舞监签认可执行；记录签认人、时间及目标与直接前置项登记行版本快照；重复签认 409 `SIGNOFF_EXISTS`，已开始/完成 409 `SIGNOFF_STATE`，已跳过 409 `CUE_SKIPPED`，未标记需放行 400 `RELEASE_NOT_REQUIRED`，**停排期间 409 `INTERRUPTION_ACTIVE`** |
| POST | `/api/registrations` | 执行岗位 | start / complete / estimate（同一事务内复核当前版、代班授权、行版本号；已跳过项 409 `CUE_SKIPPED`；需放行项 start 前须双签齐备，否则 409 `SIGNOFF_MISSING`；**停排期间 start/estimate/complete 均 409 `INTERRUPTION_ACTIVE`**） |
| POST | `/api/registrations/corrections` | 舞监 | 更正/清除单个登记字段（校验行版本号、仅当前执行版本；级联清除与一致性校验；原子写入更正历史；已跳过项 409 `CUE_SKIPPED`；**更正后的实际时刻落入任一段停排区间 400 `INTERRUPTION_TIME_CONFLICT`；停排期间仍可更正**） |
| GET | `/api/live/skips/preview` | 舞监 | **依赖链跳过影响预览**（仅当前执行版）：根项及沿前置可达的全部后继、各项行版本、阻断项与已跳过原因 |
| POST | `/api/live/skips` | 舞监 | **确认跳过整条依赖链**（非空原因 + 预览所见行版本；事务内核验，阻断/版本变化整体拒绝；首跳清除预计结束并留痕，已跳过项不重复留痕） |
| POST | `/api/live/whatif` | 舞监 | **现场顺延预演**（仅当前执行版，只读）：携带 `versionId`、全部登记行 `rows[]` 与一项或多项假设 `assumptions[]`；同一快照同时套用全部假设重算，返回逐项待执行开始/结束差异与新增/消失/仍存在的同岗位冲突；**另按现场口径返回共享资源告警的新增 / 消失 / 持续（`resourceAlertsAdded/Removed/Kept`）**；版本或任一行变化整体 409 `WHATIF_STALE`，无效假设 400 `WHATIF_INVALID`，不写入任何数据 |
| GET | `/api/live/interruptions` | 已登录 | **联排中断记录**（当前执行版）：全部停排段（留痕，最新在前）与 `activeInterruption`（进行中或 null） |
| POST | `/api/live/interruptions` | 舞监 | **停排**（仅当前执行版）：`{versionId, pauseText:"HH:MM", reason}`；同版已有进行中停排 409 `INTERRUPTION_EXISTS`；时刻不递增/覆盖已登记实际时刻 400；停排事务内清除未开始项预计结束（行版本+1、留痕）、有效双签整体失效 |
| POST | `/api/live/interruptions/resume` | 舞监 | **恢复**（仅当前执行版）：`{versionId, resumeText:"HH:MM"}`；无进行中停排 409 `NO_ACTIVE_INTERRUPTION`；时刻不晚于停排/覆盖实际时刻 400；恢复后按中断顺延规则重算（实际登记时间不变） |
| GET | `/api/versions` `/api/versions/:id` | 已登录 | 版本列表（含 `skipCount`、**`interruptionCount` / `interruptionActive`、`noticePendingCount` 顺延待确认数（舞监=全岗位，执行账号=本岗位）**、`reviewSealed` / `reviewSealedAt` 复盘封存标记）与历史回看（每行含更正历史 `corrections`、跳过留痕 `skip`、放行签认 `release` 与**中断影响标注**，**版本含 `interruptions` 停排记录与 `activeInterruption`**，含全部签认记录 `release.records` 及失效原因，只读；**另含冻结共享资源 `resources`、每行 `resourceUsages` 与按该版当前重算口径的 `resourceAlerts`；升级前发布的旧版无资源数据，三者为空，沿用原有行为**） |
| GET | `/api/versions/:id/cues/:cueRef/explain` | 已登录 | **排期开始来源解释**（当前执行版与历史版本通用，只读）：以原计划开始为基线，达到最终最大约束时刻的直接前置全部列出并逐层追溯来源；目标已开始/已完成/已跳过返回明确说明 |
| GET | `/api/live/review` | 舞监 | **当前执行版复盘实时预览**：逐项状态（本版完成 / 交接自旧版完成 / 进行中 / 未开始 / 已跳过）、开始有符号偏差、实际持续分钟、停排扣除分钟、净执行分钟，及按岗位汇总与封存依据 `basis`；无版本 409 `NO_LIVE_VERSION` |
| POST | `/api/live/review/seal` | 舞监 | **封存当前执行版复盘**：`{versionId, note?, basis}`（basis 取自预览，含全部登记行版本与停排状态）；任一依据变化 409 `REVIEW_BASIS_STALE` 整体拒绝，归档版 409 `REVIEW_VERSION_STALE`，每版重复封存 409 `REVIEW_ALREADY_SEALED`；明细与汇总作为不可改写快照保存 |
| GET | `/api/versions/:id/review` | 舞监 | **历史版复盘回看**：该版实时明细 `live` 与已封存快照 `snapshot`（未封存为 null），并带封存依据与封存信息 |
| GET | `/api/live/change-notices` | 已登录 | **顺延变更待确认清单（当前执行版）**：执行账号仅返回其当前有权负责岗位（含代班获得、排除被顶替）的记录，舞监返回全部记录；含 `pendingCount`、舞监按岗位分组 `positions`、每条 `recordVersion` 与冻结的版本/提示项/前后时刻/触发操作 |
| GET | `/api/versions/:id/change-notices` | 已登录 | **指定版本（含历史只读）顺延变更记录回看**：权限口径同上，归档版本 `isLatest=false`，记录只读 |
| POST | `/api/live/change-notices/:id/acknowledge` | 执行岗位 | **确认一条顺延变更**：请求体 `{recordVersion}`（取自清单所见，初始 1）；记录须属当前执行版且未确认、提交人当下仍负责该岗位；越权 403 `NOTICE_FORBIDDEN_POSITION`、舞监 403 `FORBIDDEN`、归档 409 `NOTICE_VERSION_ARCHIVED`、记录版本不符 409 `NOTICE_STALE`、重复确认 409 `NOTICE_ALREADY_ACKNOWLEDGED`；确认只推进该记录版本至 2，不改动任何登记 |

## 八、登记交接 API 调用示例

以本地默认端口 3000、舞监账号为例（`curl -c/-b` 复用会话 Cookie）：

### 1. 登录并预览交接资格

```bash
# 登录（保存会话 Cookie）
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"sm","password":"sm12345"}'

# 发布前预览：返回草稿版本、旧执行版、可选 / 不可选清单
curl -b sm.cookie -s http://localhost:3000/api/publish/handover/preview
```

响应示例（旧版中 L1、S1 已完成且与草稿完全一致；S2 已完成但草稿计划开始被改过）：

```json
{
  "draftVersion": 1,
  "oldVersion": { "id": 1, "versionNo": 1, "note": "首版", "createdAt": "2026-10-03 19:40:00" },
  "eligible": [
    { "cueRef": 1, "code": "L1", "title": "开场灯光就位", "position": "灯光",
      "actualStartText": "19:00", "actualEndText": "19:06", "rowVersion": 3, "selected": true },
    { "cueRef": 2, "code": "S1", "title": "开场音乐", "position": "音响",
      "actualStartText": "19:05", "actualEndText": "19:08", "rowVersion": 3, "selected": true }
  ],
  "ineligible": [
    { "cueRef": 5, "code": "S2", "title": "风声效果", "position": "音响",
      "actualStartText": "19:12", "actualEndText": "19:17", "rowVersion": 3,
      "reasons": ["计划开始不一致（旧版 19:12 → 草稿 19:13）"],
      "diffs": [{ "field": "plannedStart", "label": "计划开始", "oldText": "19:12", "newText": "19:13",
                  "reason": "计划开始不一致：旧版为 19:12，草稿为 19:13" }] }
  ]
}
```

- 首次发布（无旧版）时 `oldVersion` 为 `null`，`eligible` / `ineligible` 均为 `[]`；
- 仅「旧登记同时有实际开始和实际完成」的项会出现（只开始未完成的项不在列表中）。

### 2. 携带交接选择发布

```bash
curl -b sm.cookie -s -X POST http://localhost:3000/api/publish \
  -H 'Content-Type: application/json' -d '{
    "version": 1,
    "note": "第二场联排",
    "handover": {
      "oldVersionId": 1,
      "draftVersion": 1,
      "items": [
        { "cueRef": 1, "rowVersion": 3 },
        { "cueRef": 2, "rowVersion": 3 }
      ]
    }
  }'
```

- `version`：沿用现有发布请求的**草稿版本号**校验（不一致返回 409 `VERSION_CONFLICT`）；
- `handover.oldVersionId` / `draftVersion` / `items[].rowVersion` 均取自上一步预览；
- `items` 只放要延续的项；为空数组 `[]` 表示一项都不延续（仍会核对预览基于的草稿版本与旧版）；
- **不传 `handover` 字段时完全维持原有发布行为**（新版全部空登记）。

成功响应沿用原发布返回（新版本完整负载），并追加 `handover` 汇总；每个被延续的提示项负载中带有 `handover` 来源标注：

```json
{
  "id": 2, "versionNo": 2, "note": "第二场联排",
  "cues": [
    { "code": "L1", "status": "DONE", "actualStartText": "19:00", "actualEndText": "19:06",
      "estimatedEndText": null,
      "handover": { "sourceVersionId": 1, "sourceVersionNo": 1, "sourceCueRef": 1, "sourceCode": "L1" } }
  ],
  "handover": { "carriedCount": 2, "sourceVersionId": 1, "sourceVersionNo": 1 }
}
```

### 3. 资格 / 版本失效被整体拒绝

预览之后若草稿又被编辑、旧版被新版替代、或岗位/舞监对所选登记行又有提交（行版本推进），发布整体拒绝（不产生任何新版本、不写部分登记）：

```json
HTTP 409
{
  "error": "HANDOVER_STALE",
  "message": "交接资格核对未通过（1 项），本次发布已整体拒绝，请重新预览后再选择发布",
  "items": [
    { "cueRef": 1, "code": "L1",
      "reason": "「L1」旧登记行版本已变化（预览时 v3，当前 v4，可能被岗位登记或舞监更正更新），请重新预览后再发布",
      "currentRowVersion": 4 }
  ]
}
```

其余既有行为不变：计划冲突仍返回 **422 `PUBLISH_CONFLICT`** 并列出冲突项；草稿版本号过期返回 **409 `VERSION_CONFLICT`**。页面上的勾选与上述 API 完全等价：草稿编辑页发布面板内完成「预览 → 勾选 → 发布」，现场页与版本回看页均可看到延续项的来源标注，旧版登记与更正历史保持可回看。

## 九、岗位代班 API 调用示例

以本地默认端口 3000 为例（`curl -c/-b` 复用会话 Cookie），假设已发布第 1 版为当前执行版。

### 1. 舞监查看当前执行版代班管理视图

```bash
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"username":"sm","password":"sm12345"}'

curl -b sm.cookie -s http://localhost:3000/api/live/deputies
```

响应（舞监含可选岗位与执行账号；`deputies` 含已撤销历史，最新在前）：

```json
{
  "versionId": 1,
  "versionNo": 1,
  "deputies": [],
  "positions": ["灯光", "道具", "音响"],
  "operators": [
    { "username": "light", "displayName": "灯光执行", "position": "灯光" },
    { "username": "sound", "displayName": "音响执行", "position": "音响" }
  ]
}
```

### 2. 启用代班（灯光 → 音响执行）

```bash
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/deputies \
  -H 'Content-Type: application/json' \
  -d '{"position":"灯光","username":"sound","versionId":1}'
```

- `versionId` 可选但建议携带：若页面基于的版本已不是当前执行版，返回 409 `VERSION_STALE`，避免误操作新版本；
- 成功返回 201 与最新代班管理视图，记录含 `enabledBy` / `enabledAt`（操作者与时间）。

### 3. 代班期间的登记行为

```bash
# 原岗位账号 light 登记灯光提示项 → 403，登记权已移交
{"error":"DEPUTY_ACTIVE","message":"岗位「灯光」当前由 音响执行（sound）代班，你的该岗位登记权已暂时移交，请刷新页面"}

# 代班账号 sound 可登记灯光提示项，也可继续登记自己音响岗位（请求格式不变）
curl -b sound.cookie -s -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"cueRef":1,"rowVersion":1,"action":"start","time":"19:00"}'
```

执行账号调用 `GET /api/live` 时，响应 `version.myPositions` 给出当前有效岗位（如 sound 为 `["音响","灯光"]`，light 为 `[]`），现场页面据此显示可操作项；`version.deputies` 列出本版代班记录。

### 4. 撤销代班

```bash
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/deputies/revoke \
  -H 'Content-Type: application/json' -d '{"position":"灯光","versionId":1}'
```

- 撤销后原岗位账号立即恢复登记权；代班账号持旧页面提交返回 403 且**不改动任何登记**；
- 记录保留 `revokedBy` / `revokedAt`，与启用记录一起在回看页只读可查；重复撤销返回 409 `NO_ACTIVE_DEPUTY`。

### 5. 错误一览（均整体拒绝，不留部分记录）

| 场景 | 状态码 | error |
| --- | --- | --- |
| 账号不存在 | 404 | `UNKNOWN_ACCOUNT` |
| 账号不是执行账号 | 400 | `NOT_OPERATOR` |
| 当前执行版没有该岗位 | 400 | `POSITION_NOT_IN_VERSION` |
| 该岗位已有在任代班 | 409 | `DEPUTY_EXISTS` |
| 撤销时没有任代班 | 409 | `NO_ACTIVE_DEPUTY` |
| 尚未发布任何版本 | 409 | `NO_LIVE_VERSION` |
| 页面版本已过期 | 409 | `VERSION_STALE` |
| 原岗位账号在代班期间登记 | 403 | `DEPUTY_ACTIVE` |

发布新版后代班不自动延续（新版 `deputies` 为空）；旧版记录通过 `GET /api/versions/:id` 的 `deputies` 字段只读可查。

## 十、依赖链跳过 API 调用示例

以本地默认端口 3000、舞监账号为例（`curl -c/-b` 复用会话 Cookie）。假设第 1 版为当前执行版，示例提示项：`L1 → S1 → S2`，`L1 → P1`，`S1 → L2 → L3`（`cueRef` 即提示项引用，等于发布时的草稿 id）。

### 1. 影响预览：查看以某提示项为根的整条依赖链

```bash
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"sm","password":"sm12345"}'

# 以 S1（cueRef=2）为根：链 = S1、S2、L2、L3
curl -b sm.cookie -s "http://localhost:3000/api/live/skips/preview?cueRef=2&versionId=1"
```

响应（链按拓扑序，根项在首；`blockers` 为空表示可确认）：

```json
{
  "versionId": 1,
  "versionNo": 1,
  "root": { "cueRef": 2, "code": "S1", "title": "开场音乐", "position": "音响" },
  "chain": [
    { "cueRef": 2, "code": "S1", "title": "开场音乐", "position": "音响",
      "plannedStartText": "19:05", "plannedEndText": "19:08",
      "status": "PENDING", "rowVersion": 1, "alreadySkipped": false,
      "actualStartText": null, "actualEndText": null, "estimatedEndText": null,
      "isRoot": true, "skip": null },
    { "cueRef": 5, "code": "S2", "...": "...", "status": "PENDING", "rowVersion": 1, "isRoot": false, "skip": null },
    { "cueRef": 4, "code": "L2", "...": "...", "status": "PENDING", "rowVersion": 1, "isRoot": false, "skip": null },
    { "cueRef": 6, "code": "L3", "...": "...", "status": "PENDING", "rowVersion": 1, "isRoot": false, "skip": null }
  ],
  "blockers": [],
  "canSkip": true,
  "totalCount": 4,
  "alreadySkippedCount": 0,
  "newlySkippedCount": 4
}
```

- `blockers` 非空时 `canSkip` 为 `false`，阻断项逐项给出 `reason`（已有实际开始/完成）；
- 链中已有跳过项时 `alreadySkipped=true`、`status="SKIPPED"`，并在 `skip` 中带既有原因，只展示、不重复留痕；
- 每个 `chain[].rowVersion` 是确认时必须原样回传的**登记行版本号**。

### 2. 确认跳过整条链

请求体中的 `items` 必须与预览 `chain` 完全一致（同样的 cueRef 集合，行版本取预览所见），`reason` 必填非空（≤200 字）：

```bash
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/skips \
  -H 'Content-Type: application/json' -d '{
    "versionId": 1,
    "cueRef": 2,
    "reason": "音响设备故障，后续提示项无法执行",
    "items": [
      { "cueRef": 2, "rowVersion": 1 },
      { "cueRef": 5, "rowVersion": 1 },
      { "cueRef": 4, "rowVersion": 1 },
      { "cueRef": 6, "rowVersion": 1 }
    ]
  }'
```

成功响应：`version` 为最新现场负载（`GET /api/live` 同构，`conflicts` 已按规则重算），`skip` 为本次汇总。链中每项的 `status` 变为 `SKIPPED`，`schedStartText/schedEndText` 为 `null`，`estimatedEndText` 为 `null`（预计结束已清除），并带 `skip` 留痕：

```json
{
  "version": {
    "id": 1, "versionNo": 1, "isLatest": true,
    "cues": [
      { "code": "S1", "status": "SKIPPED",
        "plannedStartText": "19:05", "schedStartText": null, "schedEndText": null,
        "actualStartText": null, "actualEndText": null, "estimatedEndText": null,
        "rowVer": 2,
        "skip": { "reason": "音响设备故障，后续提示项无法执行",
                  "skippedBy": "舞监", "skippedAt": "2026-10-03 20:11:36",
                  "rootCueRef": 2, "rootCode": "S1" } }
    ],
    "conflicts": []
  },
  "skip": {
    "rootCueRef": 2, "rootCode": "S1",
    "reason": "音响设备故障，后续提示项无法执行",
    "skippedBy": "舞监",
    "newlySkippedCount": 4,
    "alreadySkippedCount": 0,
    "allAlreadySkipped": false
  }
}
```

- **已发布计划不变**：`plannedStartText`、时长、前置关系仍为发布时冻结值；
- 链中已跳过项不更新（`newlySkippedCount` 只计首跳项）；整链此前均已跳过时 `allAlreadySkipped=true`、`newlySkippedCount=0`，不写新留痕；
- 以被跳过项为前置、但本身不在该链闭包内的项，重算时忽略该跳过前置（见下节示例与现场负载）。

### 3. 被阻断或版本变化：整次拒绝，不留部分标记

链中 L3 已被灯光岗位登记实际开始后再确认，返回 409 且**不标记任何一项**：

```json
HTTP 409
{
  "error": "SKIP_BLOCKED",
  "message": "依赖链中 1 项已有实际开始或完成，本次跳过已整体拒绝，未标记任何项",
  "items": [
    { "cueRef": 6, "code": "L3", "currentRowVersion": 2,
      "reason": "「L3」已有实际开始 19:25，不能跳过" }
  ]
}
```

预览后有人对链中任一项提交了登记或更正（行版本推进），返回：

```json
HTTP 409
{
  "error": "VERSION_CONFLICT",
  "message": "跳过链中 1 项登记行版本已变化，本次跳过已整体拒绝，请重新预览后再确认",
  "items": [
    { "cueRef": 6, "code": "L3", "previewRowVersion": 1, "currentRowVersion": 3,
      "reason": "「L3」登记行版本已变化（预览时 v1，当前 v3），请重新预览后再确认" }
  ]
}
```

### 4. 跳过后的登记 / 更正 / 重算

```bash
# 执行账号对跳过项登记 -> 409，不改动任何数据
curl -b sound.cookie -s -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"cueRef":2,"rowVersion":2,"action":"start","time":"20:00"}'
# {"error":"CUE_SKIPPED","message":"「S1」已被舞监标记为跳过（不再执行），执行岗位不能登记；请刷新页面"}

# 舞监对跳过项更正 -> 409（跳过时间不可更正）
# {"error":"CUE_SKIPPED","message":"「S1」已被标记为跳过，跳过项的登记时间不可更正（保留已发布计划，仅展示跳过原因）"}
```

重算影响可直接对照 `GET /api/live`：

- `S1/S2/L2/L3`：`status="SKIPPED"`，无 `schedStart/schedEnd`，不出现在 `conflicts`；
- `L1`（19:00 实际完成于 19:08）未跳过；其另一个后继 `P1`（道具，前置仅 L1）正常顺延：`schedStartText="19:08"`、`delayed=true`；
- 跳过前置不约束后继：后继项只取**未跳过前置**的实际/预计结束与自身原计划开始的最大值。

### 5. 新版本不继承、旧版回看

- 发布第 2 版后，新版注册行全部为空（无 `skipped`、无 `skip`），跳过状态不延续；
- 旧版通过 `GET /api/versions/1` 回看，链中每行仍带 `skip`（原因/操作者/时间/根项），`GET /api/versions` 列表的 `skipCount` 给出每版跳过项数；
- 对非当前执行版携带旧 `versionId` 调用预览/确认返回 409 `VERSION_STALE`。

### 6. 错误一览（均整体拒绝，不留部分标记/留痕）

| 场景 | 状态码 | error |
| --- | --- | --- |
| 非舞监调用预览/确认 | 403 | `FORBIDDEN` |
| 尚未发布任何版本 | 409 | `NO_LIVE_VERSION` |
| 页面版本已过期（非当前执行版） | 409 | `VERSION_STALE` |
| 提示项不在该版本 | 404 | `NOT_FOUND` |
| 原因空 / 超 200 字 / items 缺项 | 400 | `BAD_INPUT` |
| 提交链与当前版本闭包不一致（漏项/多项） | 400 | `CHAIN_MISMATCH` |
| 链中已有实际开始或完成 | 409 | `SKIP_BLOCKED` |
| 预览所见登记行版本变化 | 409 | `VERSION_CONFLICT`（`items` 逐项列出当前版本） |
| 执行账号登记跳过项 / 舞监更正跳过项 | 409 | `CUE_SKIPPED` |

## 十一、排期来源解释 API 调用示例（本轮新增）

以本地默认端口 3000 为例（`curl -c/-b` 复用会话 Cookie）。舞监与执行岗位调用方式相同；当前执行版与历史版本均用同一端点，按版本 id 查询，只读、不改动登记与已发布计划。

### 1. 查询某提示项排期开始时刻的来源链

```bash
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"username":"sm","password":"sm12345"}'

# 第 1 版中 S2（cueRef=5）为何顺延到 19:14？
curl -b sm.cookie -s http://localhost:3000/api/versions/1/cues/5/explain
```

响应（`applicable=true`）：以原计划开始为基线，达到最终最大约束时刻的直接前置全部列出；多层未开始前置嵌套在 `constraints[].start` 中逐层追溯：

```json
{
  "versionId": 1, "versionNo": 1, "isLatest": true,
  "applicable": true,
  "cue": { "cueRef": 5, "code": "S2", "title": "风声效果", "position": "音响",
           "plannedStartText": "19:12", "plannedEndText": "19:17", "duration": 5,
           "status": "PENDING", "schedStartText": "19:14", "schedEndText": "19:19", "delayed": true },
  "baselineText": "19:12",
  "maxTimeText": "19:14",
  "delayMinutes": 2,
  "decidedByPlan": false,
  "delayed": true,
  "constraints": [
    { "cueRef": 2, "code": "S1", "status": "PENDING",
      "endText": "19:14", "endSource": "estimated", "endSourceLabel": "预计结束",
      "endDetail": "登记的预计结束 19:14" }
  ],
  "skippedPreds": [],
  "otherPreds": [],
  "summary": "「S2」重算开始 19:14，较原计划 19:12 顺延 2 分钟；达到最终约束时刻 19:14 的直接前置共 1 条，全部展示"
}
```

- `endSource` 取值：`actual`（实际完成）、`estimated`（预计结束）、`duration`（按时长推算：实际/重算开始 + 时长）；
- 直接前置为**未开始且按时长推算**时，`constraints[].start` 嵌套其自身重算开始的同构解释（`plannedStartText` 基线、`constraints` 下一层来源），逐层直到实际完成 / 预计结束 / 原计划为止；
- **同一最大时刻由多条路径共同决定时 `constraints` 含多条**（如 S1 与 P1 的预计结束同为 19:14，则两条都列出），不任意取舍；
- `skippedPreds`：已跳过前置（不构成约束，附跳过原因）；`otherPreds`：结束时刻早于最终约束的其他前置；
- 原计划本身决定开始时 `decidedByPlan=true`、`delayMinutes=0`，`summary` 为「按原计划 19:05 开始，无需顺延」；若有前置结束恰与原计划同刻到达，会在 `constraints` 中列出并注明未造成顺延。

### 2. 目标已开始 / 已完成 / 已跳过：明确结果

```json
HTTP 200
{ "versionId": 1, "versionNo": 1, "isLatest": true,
  "applicable": false,
  "cue": { "cueRef": 1, "code": "L1", "status": "DONE", "statusLabel": "已完成", "...": "..." },
  "reason": "「L1」已完成（实际开始 19:00，实际完成 19:06），不存在待解释的排期开始" }
```

已开始（`RUNNING`）与已跳过（`SKIPPED`）同理返回 `applicable=false` 与明确 `reason`；均不产生任何写操作。

### 3. 错误一览

| 场景 | 状态码 | error |
| --- | --- | --- |
| 未登录 | 401 | `UNAUTHORIZED` |
| 版本不存在 | 404 | `NOT_FOUND`（版本不存在） |
| 提示项不在该版本 | 404 | `NOT_FOUND`（提示项不存在于该版本） |
| cueRef 非法 | 400 | `BAD_INPUT` |

### 4. 与现场重算的一致性与刷新

- 解释与 `GET /api/live` / `GET /api/versions/:id` 的重算结果**同源**（同一 `computeLive` 计算）：解释中目标项的 `schedStartText` 与现场页「重算开始」逐项一致；
- 登记、舞监更正或依赖链跳过后，重新打开「来源」弹窗（或刷新页面）即可看到新解释；历史版本按归档状态只读回看，不随新登记变化之外的任何写操作影响（解释接口本身不写入任何数据）。


## 十二、现场顺延预演 API 调用示例（本轮新增）

以本地默认端口 3000、舞监账号为例（`curl -c/-b` 复用会话 Cookie）。仅舞监可调用，仅当前执行版可用，接口**只读**：不更改登记、已发布计划、跳过状态与更正历史。

请求体三部分：

- `versionId`：页面所见的当前执行版 id；
- `rows`：**当前版本全部提示项**的登记行 `{cueRef, rowVersion}`（取自 `GET /api/live` 每行的 `id` 与 `rowVer`，一项不能少）；
- `assumptions`：一项或多项假设 `{cueRef, estimatedEndText}`（HH:MM），仅可针对未完成、未跳过提示项。

### 1. 登录并获取当前版本与全部行版本

```bash
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"sm","password":"sm12345"}'

# 取当前执行版 id、每行 cueRef(id) 与 rowVer
curl -b sm.cookie -s http://localhost:3000/api/live
```

### 2. 提交多项假设，查看变更前后逐项差异与冲突变化

```bash
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/whatif \
  -H 'Content-Type: application/json' -d '{
    "versionId": 3,
    "rows": [
      {"cueRef": 1, "rowVersion": 1}, {"cueRef": 2, "rowVersion": 1},
      {"cueRef": 3, "rowVersion": 1}, {"cueRef": 4, "rowVersion": 1},
      {"cueRef": 5, "rowVersion": 1}, {"cueRef": 6, "rowVersion": 1},
      {"cueRef": 7, "rowVersion": 1}
    ],
    "assumptions": [
      {"cueRef": 1, "estimatedEndText": "19:22"}
    ]
  }'
```

响应要点（`baseline*` 为变更前、`scenario*` 为同时套用全部假设后）：

```json
{
  "versionId": 3, "versionNo": 3, "isLatest": true,
  "readAt": "2026-10-04 19:02:11", "readOnly": true,
  "assumptions": [{ "cueRef": 1, "code": "L1", "estimatedEndText": "19:22" }],
  "summary": {
    "cueCount": 7, "assumedCount": 1, "changedCount": 6,
    "baselineConflictCount": 0, "scenarioConflictCount": 2,
    "addedCount": 2, "removedCount": 0, "keptCount": 0
  },
  "cues": [
    { "cueRef": 1, "code": "L1", "status": "PENDING", "assumed": true,
      "plannedStartText": "19:00", "plannedEndText": "19:05",
      "baselineStartText": "19:00", "baselineEndText": "19:05",
      "scenarioStartText": "19:00", "scenarioEndText": "19:22",
      "startDeltaMinutes": 0, "endDeltaMinutes": 13, "changed": true, "delayed": false }
  ],
  "conflictsAdded": [
    { "position": "灯光", "aRef": 4, "bRef": 7, "codes": ["L2", "L4"],
      "message": "岗位「灯光」执行时段冲突：「L2」(19:25-19:33) 与「L4」(19:30-19:36)" }
  ],
  "conflictsRemoved": [],
  "conflictsKept": []
}
```

- `cues[].baselineStartText/baselineEndText`、`scenarioStartText/scenarioEndText`：变更前后**待执行开始/结束**（已跳过项均为 `null`）；
- `startDeltaMinutes/endDeltaMinutes`：预演相对基线的分钟差（正数推迟、负数回缩、0 无变化）；`assumed=true` 标记假设项；
- `conflictsAdded`（🔴 新增）/ `conflictsRemoved`（🟢 消失，消息描述基线时段）/ `conflictsKept`（🟠 仍存在，含 `baseline` 与 `scenario` 两条消息，时段变化时可前后对照）。

### 3. 同批假设联动：前置项与后继项同时给假设

假设会**一次性同时套用**再按前置规则重算：下例中 S1 未开始，其预演开始由同批 L1 假设推到 19:22，故 S1 的假设结束 19:30 合法（不早于预演开始）；L2/S2 随之从 19:30 起。

```bash
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/whatif \
  -H 'Content-Type: application/json' -d '{
    "versionId": 3,
    "rows": [ {"cueRef":1,"rowVersion":1}, {"cueRef":2,"rowVersion":1}, {"cueRef":3,"rowVersion":1},
              {"cueRef":4,"rowVersion":1}, {"cueRef":5,"rowVersion":1}, {"cueRef":6,"rowVersion":1},
              {"cueRef":7,"rowVersion":1} ],
    "assumptions": [
      {"cueRef": 1, "estimatedEndText": "19:22"},
      {"cueRef": 2, "estimatedEndText": "19:30"}
    ]
  }'
```

### 4. 冲突消失：把导致顺延的假设回缩

当基线冲突来自某项既有预计结束（岗位登记或舞监更正），可对该项预演一个更早的假设（未开始项允许早于既有预计，只要不早于预演开始），`conflictsRemoved` 给出随假设消失的冲突；`summary.baselineConflictCount` 大于 0、`scenarioConflictCount` 为 0。

### 5. 无效假设 / 版本变化：整体拒绝

| 场景 | 状态码 | error |
| --- | --- | --- |
| 未登录 / 执行账号调用 | 401 / 403 | `UNAUTHORIZED` / `FORBIDDEN` |
| 尚未发布任何版本 | 409 | `NO_LIVE_VERSION` |
| 携带的 `versionId` 已不是当前执行版 | 409 | `VERSION_STALE` |
| 版本不存在 / cueRef 不在版本中（行数量或引用不一致） | 404 / 409 | `NOT_FOUND` / `WHATIF_STALE` |
| 任一登记行版本已变化（岗位登记、舞监更正、跳过推进了 rowVer） | 409 | `WHATIF_STALE`（`items` 逐项给出 `previewRowVersion/currentRowVersion`） |
| 时间格式无效、同一 cueRef 重复（请求级或假设级） | 400 | `BAD_INPUT` / `WHATIF_INVALID` |
| 对已完成 / 已跳过项填写假设 | 400 | `WHATIF_INVALID`（逐项原因） |
| 已开始项假设早于实际开始；未开始项假设早于预演算出的开始 | 400 | `WHATIF_INVALID`（逐项原因） |
| 假设列表为空 | 400 | `WHATIF_INVALID` |

典型 409 响应（整体拒绝，前端应整页刷新后重新预演）：

```json
HTTP 409
{
  "error": "WHATIF_STALE",
  "message": "执行版或登记行已变化（1 项），本次预演已整体拒绝，请刷新后重新预演",
  "items": [
    { "cueRef": 1, "code": "L1", "previewRowVersion": 1, "currentRowVersion": 2,
      "reason": "「L1」登记行版本已变化（提交基于 v1，当前 v2，可能被岗位登记、舞监更正或跳过更新），请刷新后重新预演" }
  ],
  "currentVersionId": 3, "currentVersionNo": 3
}
```

典型 400 响应（逐项列出不成立的假设，不写入任何数据）：

```json
HTTP 400
{
  "error": "WHATIF_INVALID",
  "message": "1 项假设不成立，本次预演已整体拒绝（未更改任何登记、计划与更正历史）",
  "items": [
    { "cueRef": 2, "code": "S1",
      "reason": "「S1」未开始：假设预计结束 19:00 早于预演算出的开始 19:05" }
  ]
}
```

预演全程只读：重复调用、试算不同假设均不会改变 `GET /api/live` 的任何结果（登记时间、行版本、冲突、更正历史保持原样）。

## 十三、双人放行签认 API 调用示例（本轮新增）

以本地默认端口 3000 为例（`curl -c/-b` 复用会话 Cookie）。流程：舞监在草稿为提示项标记「需放行」→ 发布 → 执行人与舞监分别签认 → 双签齐备后岗位登记实际开始。

### 1. 草稿标记「需放行」并发布

```bash
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"username":"sm","password":"sm12345"}'

# 编辑提示项时携带 needsRelease:true（其余字段同现有草稿编辑；行版本/草稿版本校验不变）
curl -b sm.cookie -s -X PUT http://localhost:3000/api/draft/cues/4 \
  -H 'Content-Type: application/json' -d '{
    "version": 0, "rowVersion": 1,
    "code": "L2", "title": "追光主角上场", "position": "灯光",
    "plannedStartText": "19:10", "duration": 8, "needsRelease": true
  }'

# 发布（标记随版本冻结；新版无签认记录）
curl -b sm.cookie -s -X POST http://localhost:3000/api/publish \
  -H 'Content-Type: application/json' -d '{"version":1,"note":"首版"}'
```

发布后 `GET /api/live` 中需放行项带有签认状态（未标记项为 `{"required":false}`）：

```json
{ "code": "L2", "needsRelease": true, "rowVer": 1,
  "release": { "required": true, "ready": false,
    "operator": { "state": "missing" },
    "sm": { "state": "missing" },
    "records": [] } }
```

### 2. 未签认直接登记开始 → 409 明确拒绝，不写入任何登记

```bash
curl -c light.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"username":"light","password":"light123"}'

curl -b light.cookie -s -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"cueRef":4,"rowVersion":1,"action":"start","time":"19:10"}'
```

```json
HTTP 409
{ "error": "SIGNOFF_MISSING",
  "message": "「L2」为需放行项，须双人放行后才能登记实际开始：缺少有效的执行人签认（本岗位当班执行人「签认就绪」）；缺少有效的舞监签认（舞监「签认可执行」）；请完成签认或刷新查看最新签认状态",
  "items": [
    { "kind": "operator", "reason": "缺少有效的执行人签认（本岗位当班执行人「签认就绪」）", "cueRef": 4, "code": "L2" },
    { "kind": "sm", "reason": "缺少有效的舞监签认（舞监「签认可执行」）", "cueRef": 4, "code": "L2" }
  ] }
```

### 3. 执行人签认就绪 + 舞监签认可执行

```bash
# 执行人：只能为自己当下有登记权的岗位签认（非本岗位 403；被代班顶替 403 DEPUTY_ACTIVE）
curl -b light.cookie -s -X POST http://localhost:3000/api/live/signoffs \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"cueRef":4,"rowVersion":1,"kind":"operator"}'

# 舞监签认（kind=sm；执行账号调用 403）
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/signoffs \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"cueRef":4,"rowVersion":1,"kind":"sm"}'
```

- 成功返回 **201** 与最新现场负载（同 `GET /api/live`）；签认**不推进登记行版本**，两类签认可先后基于同一 `rowVersion` 提交；
- 签认后该项 `release.operator` / `release.sm` 变为 `{"state":"valid","signedBy":"灯光执行","signedAt":"...","targetRowVer":1,"preds":[{"cueRef":2,"rowVer":1,"code":"S1"}]}`——记录签认人、时间及**目标与直接前置项的登记行版本快照**；
- 同类已有有效签认时重复提交返回 409 `SIGNOFF_EXISTS`；行版本过期返回 409 `VERSION_CONFLICT`。

### 4. 双签齐备后登记开始

```bash
curl -b light.cookie -s -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"cueRef":4,"rowVersion":1,"action":"start","time":"19:10"}'
# 200：登记成功。预计结束（estimate）与完成（complete）登记不需要签认，沿用原有请求格式与校验。
```

### 5. 签认失效：目标或任一直接前置项登记行变化

签认后若目标项（或以上例中直接前置 `S1`）发生岗位登记 / 舞监更正 / 跳过（行版本推进），相关签认即失效，`GET /api/live` 中可看到失效原因：

```json
{ "code": "L2",
  "release": { "required": true, "ready": false,
    "operator": { "state": "invalid", "signedBy": "灯光执行", "signedAt": "2026-10-04 19:02:11",
      "invalidReason": "直接前置「S1」登记已更新（行版本推进至 v2），签认失效",
      "invalidatedAt": "2026-10-04 19:03:40", "targetRowVer": 1,
      "preds": [{ "cueRef": 2, "rowVer": 1, "code": "S1" }] },
    "sm": { "state": "invalid", "...": "..." },
    "records": [ { "id": 2, "kind": "sm", "active": false, "invalidReason": "...", "...": "..." } ] } }
```

失效后需双方重新签认（基于最新行版本）才能登记开始；开始提交时服务端在同一事务内复核签认快照与当前行版本，过期仍整体拒绝。

### 6. 签认失效：代班变更

```bash
# 舞监启用灯光代班（音响执行代班）后：light 对灯光岗需放行项的执行人签认立即失效
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/deputies \
  -H 'Content-Type: application/json' -d '{"position":"灯光","username":"sound","versionId":1}'
# light 再签认 -> 403 DEPUTY_ACTIVE；sound（代班）可签认；
# 撤销代班后，sound 的签认随之失效（失效原因：岗位「灯光」代班变更，签认人已不再拥有该岗位登记权）。
# 舞监签认不受代班影响。
```

### 7. 版本边界与回看

- 发布新版后，新版需放行项 `release.records` 为空（**不继承签认**）；交接带入的已完成项不追补签认；
- 历史版本通过 `GET /api/versions/:id` 回看，每行 `release.records` 含全部签认记录（签认人、时间、目标与直接前置行版本快照、失效原因），只读；
- 对归档版本签认返回 409 `VERSION_ARCHIVED`。

### 8. 错误一览（均整体拒绝，不写入部分结果）

| 场景 | 状态码 | error |
| --- | --- | --- |
| 未登录 / 执行账号签认「可执行」/ 舞监签认「就绪」 | 401 / 403 | `UNAUTHORIZED` / `FORBIDDEN` |
| 签认非本岗位提示项 | 403 | `FORBIDDEN` |
| 被代班顶替的原岗位账号签认 | 403 | `DEPUTY_ACTIVE` |
| 版本不存在 / 提示项不在该版本 | 404 | `NOT_FOUND` |
| 对归档版本签认 | 409 | `VERSION_ARCHIVED` |
| 提示项未标记「需放行」 | 400 | `RELEASE_NOT_REQUIRED` |
| 签认类型无效 | 400 | `BAD_INPUT` |
| 登记行版本过期 | 409 | `VERSION_CONFLICT` |
| 同类有效签认已存在 | 409 | `SIGNOFF_EXISTS` |
| 已开始 / 已完成项签认 | 409 | `SIGNOFF_STATE` |
| 已跳过项签认 | 409 | `CUE_SKIPPED` |
| 需放行项缺有效双签即登记开始 | 409 | `SIGNOFF_MISSING`（`items` 逐项列出缺失类别） |

## 十四、联排中断 API 调用示例（本轮新增）

以本地默认端口 3000、舞监账号为例（`curl -c/-b` 复用会话 Cookie）。仅舞监可停排/恢复，且仅作用于**当前执行版**；执行岗位在停排期间的一切登记/新签认被拒绝。

### 1. 停排：登记停排时刻与非空原因

```bash
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"sm","password":"sm12345"}'

curl -b sm.cookie -s -X POST http://localhost:3000/api/live/interruptions \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"pauseText":"20:13","reason":"舞台机械故障，紧急停排"}'
```

成功返回 **201**，负载为最新现场（同 `GET /api/live`）并附 `activeInterruption` 与被清除预计结束的计数：

```json
{
  "version": {
    "id": 1, "versionNo": 1, "isLatest": true,
    "activeInterruption": {
      "id": 3, "pauseText": "20:13", "reason": "舞台机械故障，紧急停排",
      "pausedBy": "舞监", "pausedAt": "2026-10-05 20:13:40",
      "resumeText": null, "durationMinutes": null, "active": true
    },
    "interruptions": [ { "pauseText": "19:40", "resumeText": "19:50", "durationMinutes": 10, "active": false, "...": "..." } ],
    "cues": [
      { "code": "S1", "status": "PENDING", "estimatedEndText": null, "rowVer": 3,
        "interrupted": false, "pauseShiftMinutes": 0, "pauseHoldText": null,
        "corrections": [
          { "field": "estimated_end", "oldValueText": "20:20", "newValueText": null,
            "reason": "联排于 20:13 停排（舞台机械故障，紧急停排），停排时清除未开始项原预计结束",
            "correctedBy": "舞监", "correctedAt": "2026-10-05 20:13:40" } ] },
      { "code": "L2", "status": "PENDING",
        "release": { "required": true, "ready": false,
          "operator": { "state": "invalid", "invalidReason": "联排于 20:13 停排（舞台机械故障，紧急停排），停排前双签失效，须恢复后重新签认", "...": "..." },
          "sm": { "state": "invalid", "...": "..." } } }
    ]
  },
  "interruption": { "pauseText": "20:13", "active": true, "...": "..." },
  "clearedEstimatedEnds": 2
}
```

要点：

- **未开始、未跳过**项的预计结束在停排事务内被清除，`rowVer` +1 并在 `corrections` 留痕；
- **停排前的有效双签全部失效**（`release.operator/sm.state="invalid"`，失效原因保留；`records` 仍可回看）；
- 已开始未完成项的实际开始/预计结束登记值**不变**（停排中暂不顺延展示，恢复后重算）。

### 2. 停排期间的拒绝（不留部分记录）

```bash
# 执行账号开始 / 预计结束 / 完成登记 → 409
curl -b light.cookie -s -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"cueRef":4,"rowVersion":2,"action":"start","time":"20:15"}'
# {"error":"INTERRUPTION_ACTIVE","message":"第 1 版当前处于停排中（20:13 起，原因：舞台机械故障，紧急停排），停排期间不能登记开始 / 预计结束 / 完成，请等待舞监恢复联排后再登记","pauseText":"20:13"}

# 新签认（执行人/舞监）→ 409 INTERRUPTION_ACTIVE
# 发布新版 → 409 INTERRUPTION_ACTIVE（须先恢复）
# 舞监把实际时刻更正进停排区间 → 400
curl -b sm.cookie -s -X POST http://localhost:3000/api/registrations/corrections \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"cueRef":1,"rowVersion":3,"field":"actual_end","actualEndText":"20:14","reason":"误填停排区间"}'
# {"error":"INTERRUPTION_TIME_CONFLICT","message":"更正后的实际完成 20:14 落入联排停排区间，停排期间没有实际执行，请改为停排前或恢复后的时刻"}

# 舞监更正为停排前时刻仍可办理；依赖链跳过也可办理。
```

### 3. 恢复：补记恢复时刻，排期自动顺延

```bash
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/interruptions/resume \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"resumeText":"20:25"}'
```

成功返回 **200**（负载同 `GET /api/live`）。假设某已开始项 20:00 实际开始、时长 8 分（推算结束 20:08），中断为 20:13–20:25（12 分）：

```json
{
  "version": {
    "activeInterruption": null,
    "cues": [
      { "code": "Lx", "status": "RUNNING", "actualStartText": "20:00",
        "schedStartText": "20:00", "schedEndText": "20:25",
        "pauseShiftMinutes": 17, "pauseHoldText": null, "interrupted": true },
      { "code": "Sy", "status": "PENDING",
        "schedStartText": "20:25", "schedEndText": "20:30",
        "pauseHoldText": "20:25", "interrupted": true, "estimatedEndText": null }
    ],
    "conflicts": [ { "position": "灯光", "...": "顺延产生的同岗位冲突随重算同步更新" } ]
  },
  "interruption": { "pauseText": "20:13", "resumeText": "20:25", "durationMinutes": 12, "active": false }
}
```

- 已开始项：推算结束 20:08 + 实际开始后中断 12 分 = 20:20，再**托底到最近恢复时刻 20:25**（`pauseShiftMinutes=17` 为相对原值的总变化；实际登记时间不变）；
- 未开始项：`schedStartText` **不早于恢复时刻 20:25**（`pauseHoldText="20:25"`），原预计结束停排时已清除、不自动恢复；
- 需放行项：恢复后旧双签仍为失效，**执行人与舞监重新签认齐备后**才能登记开始（否则 409 `SIGNOFF_MISSING`）。

### 4. 时刻与重复操作校验

```bash
# 时刻格式错误 / 原因为空 → 400 BAD_INPUT
# 恢复时刻不晚于停排时刻、再次停排不晚于最近恢复时刻 → 400 INTERRUPTION_TIME_INVALID
# 停排/恢复时刻覆盖已登记实际开始或完成 → 400 INTERRUPTION_TIME_CONFLICT（items 逐项列出）
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/interruptions \
  -H 'Content-Type: application/json' -d '{"versionId":1,"pauseText":"19:00","reason":"覆盖实际开始"}'
# {"error":"INTERRUPTION_TIME_CONFLICT","message":"停排时刻 19:00 会覆盖 1 项已登记的实际开始 / 完成，请核对时刻",
#  "items":[{"cueRef":1,"code":"L1","reason":"「L1」实际开始 19:00 不早于停排时刻 19:00，停排不能覆盖已登记的实际时刻"}]}

# 同版重复停排 → 409 INTERRUPTION_EXISTS；无进行中停排却恢复 → 409 NO_ACTIVE_INTERRUPTION
```

### 5. 查询与历史回看

```bash
# 当前执行版的全部停排段（最新在前）与进行中停排
curl -b sm.cookie -s http://localhost:3000/api/live/interruptions

# 版本列表含停排段数与是否进行中
curl -b sm.cookie -s http://localhost:3000/api/versions
# {"versions":[{"versionNo":1,"interruptionCount":2,"interruptionActive":false,"...":"..."}]}

# 历史版本回看含 interruptions（只读）；行负载含 interrupted / pauseShiftMinutes / pauseHoldText
curl -b sm.cookie -s http://localhost:3000/api/versions/1
```

错误码一览（均在同一事务内核验，**整体拒绝、不留部分记录**）：

| 场景 | 状态码 | error |
| --- | --- | --- |
| 停排时刻/恢复时刻非 HH:MM、原因空或超 200 字 | 400 | `BAD_INPUT` |
| 时刻不严格递增（≤ 最近恢复 / ≤ 停排） | 400 | `INTERRUPTION_TIME_INVALID` |
| 停排/恢复/更正时刻覆盖或落入停排区间 | 400 | `INTERRUPTION_TIME_CONFLICT`（`items` 逐项列出） |
| 同版已有进行中停排仍发起停排 | 409 | `INTERRUPTION_EXISTS` |
| 无进行中停排却恢复 | 409 | `NO_ACTIVE_INTERRUPTION` |
| 停排期间执行登记 / 新签认 / 发布新版 | 409 | `INTERRUPTION_ACTIVE` |
| 对归档版本停排 / 恢复 / 携带过期 versionId | 409 | `VERSION_ARCHIVED` |

## 十五、执行版复盘 API 调用示例（本轮新增）

以本地默认端口 3000、舞监账号为例（`curl -c/-b` 复用会话 Cookie）。仅舞监可调用；当前执行版可预览与封存，历史版可回看实时明细与已封存快照。

### 1. 查看当前执行版复盘预览（只读）

```bash
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"sm","password":"sm12345"}'

curl -b sm.cookie -s http://localhost:3000/api/live/review
```

响应包含实时明细 `live`、封存依据 `basis` 与封存状态 `sealed`（未封存为 null）：

```json
{
  "versionId": 1, "versionNo": 1, "isLatest": true,
  "live": {
    "cues": [
      { "cueRef": 1, "code": "L1", "title": "开场灯光就位", "position": "灯光",
        "plannedStartText": "19:00", "plannedEndText": "19:05", "plannedDuration": 5,
        "status": "DONE", "statusLabel": "本版完成",
        "actualStartText": "19:00", "actualEndText": "19:04",
        "startDeltaMinutes": 0, "actualDurationMinutes": 4,
        "deductedPauseMinutes": 0, "netDurationMinutes": 4,
        "rowVer": 3, "handover": null, "countedInSummary": true },
      { "cueRef": 3, "code": "P1", "title": "一桌二椅", "position": "道具",
        "status": "DONE", "actualStartText": "19:04", "actualEndText": "19:12",
        "startDeltaMinutes": -1, "actualDurationMinutes": 8,
        "deductedPauseMinutes": 4, "netDurationMinutes": 4, "countedInSummary": true },
      { "cueRef": 4, "code": "L2", "status": "RUNNING",
        "startDeltaMinutes": null, "actualDurationMinutes": null, "netDurationMinutes": null },
      { "cueRef": 2, "code": "S1", "status": "PENDING",
        "startDeltaMinutes": null, "actualDurationMinutes": null, "netDurationMinutes": null },
      { "cueRef": 6, "code": "L3", "status": "SKIPPED",
        "startDeltaMinutes": null, "actualDurationMinutes": null, "netDurationMinutes": null }
    ],
    "positions": [
      { "position": "灯光", "doneCount": 1, "netDurationMinutes": 4, "startDeltaSum": 0 },
      { "position": "道具", "doneCount": 1, "netDurationMinutes": 4, "startDeltaSum": -1 }
    ],
    "totals": { "doneCount": 2, "netDurationMinutes": 8, "startDeltaSum": -1 },
    "counts": { "total": 6, "done": 2, "doneHandover": 0, "running": 1, "pending": 2, "skipped": 1 }
  },
  "basis": {
    "versionId": 1,
    "rows": [ { "cueRef": 1, "rowVersion": 3 }, { "cueRef": 2, "rowVersion": 1 } ],
    "closedInterruptions": [ { "id": 1, "pauseText": "19:05", "resumeText": "19:09" } ],
    "activePause": null
  },
  "sealed": null
}
```

字段约定：

- `status`：`DONE` 本版完成；`DONE_HANDOVER` 交接自旧版完成（带 `handover.sourceVersionNo/sourceCode`，`countedInSummary=false`，净执行为 null）；`RUNNING` 进行中；`PENDING` 未开始；`SKIPPED` 已跳过；
- `startDeltaMinutes` 为**有符号**偏差（晚开始为正）；仅完成项（含交接完成）有值，其余状态为 null；
- `netDurationMinutes` 仅**本版完成**项有值＝实际持续 − 实际区间与已结束停排段（半开）交集分钟（重叠分钟只扣一次）；交接完成 / 进行中 / 未开始 / 已跳过均为 null；
- `positions` 与 `totals` 只统计本版完成项；`counts` 给出五类状态计数。

### 2. 携预览依据封存复盘

把上一步响应中的 `basis` **原样回传**（`rows` 也可放在顶层），可选附 200 字内备注：

```bash
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/review/seal \
  -H 'Content-Type: application/json' -d '{
    "versionId": 1,
    "note": "首场联排复盘",
    "basis": {
      "versionId": 1,
      "rows": [ {"cueRef": 1, "rowVersion": 3}, {"cueRef": 2, "rowVersion": 1},
                {"cueRef": 3, "rowVersion": 3}, {"cueRef": 4, "rowVersion": 1},
                {"cueRef": 5, "rowVersion": 1}, {"cueRef": 6, "rowVersion": 2} ],
      "closedInterruptions": [ {"id": 1, "pauseText": "19:05", "resumeText": "19:09"} ],
      "activePause": null
    }
  }'
```

成功返回 **201**，负载与 `GET /api/live/review` 同构，且 `sealed` 变为封存信息：

```json
{ "versionId": 1, "versionNo": 1, "isLatest": true,
  "live": { "…": "封存时刻的实时明细（同时已固化为快照）" },
  "basis": { "…": "封存核对依据" },
  "sealed": { "note": "首场联排复盘", "sealedBy": "舞监", "sealedAt": "2026-10-05 21:02:11" } }
```

### 3. 依据变化 / 重复封存 / 归档版：整体拒绝

```json
HTTP 409
{
  "error": "REVIEW_BASIS_STALE",
  "message": "封存依据已变化（1 项登记行），本次封存已整体拒绝，请刷新预览后再封存",
  "items": [
    { "cueRef": 1, "code": "L1", "previewRowVersion": 3, "currentRowVersion": 4,
      "reason": "「L1」登记行版本已变化（预览时 v3，当前 v4，可能被登记更正、岗位登记或停排更新），请重新打开预览后再封存" }
  ]
}
```

| 场景 | 状态码 | error |
| --- | --- | --- |
| 未登录 / 执行账号调用复盘接口 | 401 / 403 | `UNAUTHORIZED` / `FORBIDDEN` |
| 尚未发布任何版本时预览 | 409 | `NO_LIVE_VERSION` |
| 版本不存在（封存 / 回看） | 404 | `NOT_FOUND` |
| 缺 `basis` / `rows`、行内缺 cueRef/rowVersion、重复 cueRef、备注超长 | 400 | `BAD_INPUT` |
| 任一登记行版本推进 / 行集合变化 | 409 | `REVIEW_BASIS_STALE`（`items` 逐项给出当前版本） |
| 停排段新增 / 时刻变化 / 预览后进入或结束停排 | 409 | `REVIEW_BASIS_STALE`（逐项说明） |
| 归档版本（已有更新版）再封存 | 409 | `REVIEW_VERSION_STALE` |
| 同一版本重复封存 | 409 | `REVIEW_ALREADY_SEALED` |

### 4. 历史版回看：实时明细 + 已封存快照

```bash
curl -b sm.cookie -s http://localhost:3000/api/versions/1/review
```

```json
{
  "versionId": 1, "versionNo": 1, "isLatest": false,
  "live": { "cues": ["…该版当前实时明细（封存后的更正会反映在这里）…"], "positions": [], "totals": {}, "counts": {} },
  "basis": { "…": "当前依据（仅展示）" },
  "sealed": { "note": "首场联排复盘", "sealedBy": "舞监", "sealedAt": "2026-10-05 21:02:11" },
  "snapshot": {
    "note": "首场联排复盘", "sealedBy": "舞监", "sealedAt": "2026-10-05 21:02:11",
    "detail": [ "…封存当时逐项明细，此后任何更正 / 交接 / 发布新版均不改写…" ],
    "summary": { "versionId": 1, "versionNo": 1,
      "counts": { "total": 6, "done": 2, "doneHandover": 0, "running": 1, "pending": 2, "skipped": 1 },
      "positions": [], "totals": { "doneCount": 2, "netDurationMinutes": 8, "startDeltaSum": -1 } },
    "basis": { "…": "封存时核对通过的依据快照" }
  }
}
```

- 未封存的版本 `snapshot` 为 `null`；封存后即便舞监继续更正该版登记，`snapshot.detail / summary` 仍保持封存时刻内容，`live` 显示最新实时明细；
- 版本列表 `GET /api/versions` 每项带 `reviewSealed`（布尔）与 `reviewSealedAt`。

## 十六、共享资源 API 调用示例（本轮新增）

以本地默认端口 3000、舞监账号为例（`curl -c/-b` 复用会话 Cookie）。

### 1. 草稿中配置资源与占用

```bash
# 登录
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"username":"sm","password":"sm12345"}'

# 新增共享资源：名称 + 正整数容量
curl -b sm.cookie -s -X POST http://localhost:3000/api/draft/resources \
  -H 'Content-Type: application/json' -d '{"version":3,"name":"无线麦","capacity":2}'
# 201：返回完整草稿负载；resources 每项含 id/name/capacity/cueCount（被引用提示项数）

# 编辑提示项时携带 resources（resourceId 取自草稿资源；usage 为正整数，留空字段直接不传）
curl -b sm.cookie -s -X PUT http://localhost:3000/api/draft/cues/4 \
  -H 'Content-Type: application/json' -d '{
    "version": 4, "rowVersion": 2,
    "code": "L2", "title": "追光主角上场", "position": "灯光",
    "plannedStartText": "19:10", "duration": 8,
    "resources": [ { "resourceId": 1, "usage": 2 } ]
  }'
```

提示项负载中占用形如 `resourceUsages: [{"resourceId":1,"resourceName":"无线麦","usage":2}]`；不带 `resources` 字段的请求保持原行为（不改变既有占用的语义仅在表单提交时体现——页面提交始终全量携带，空数组即清空）。

### 2. 超额阻止发布（半开时段累计）

资源容量 2，而 `L1`（19:00-19:05，占 1）、`S1`（19:05-19:08，占 1）、`L2`（19:05 开始，占 1）在 19:05-19:08 同时需要无线麦时（S1 与 L1 首尾相接**不**累计），`GET /api/draft` 的校验为：

```json
{
  "ok": false,
  "errors": [
    { "type": "RESOURCE_OVERLOAD", "resource": "无线麦", "capacity": 2,
      "startText": "19:05", "endText": "19:08", "used": 3, "over": 1, "codes": ["S1", "L2"],
      "message": "共享资源「无线麦」容量 2 在 19:05-19:08 被占用 3（超额 1），相关提示项：「S1」占 1、「L2」占 2" }
  ]
}
```

此时 `POST /api/publish` 返回 **422 `PUBLISH_CONFLICT`**，`errors` 内含上述明细，不产生新版本。校验通过后发布，响应（及之后的 `GET /api/live` / `GET /api/versions/:id`）带：

```json
{
  "resources": [ { "id": 1, "name": "无线麦", "capacity": 2 } ],
  "resourceAlerts": []
}
```

### 3. 现场资源告警（不阻止登记）

发布后舞监把 `L1` 更正（或岗位登记）为实际/预计执行到 19:08，与未开始的 `L2`（顺延后 19:05-19:13）在资源上重叠，`GET /api/live` 的 `resourceAlerts`：

```json
[
  { "resourceId": 1, "resource": "无线麦", "capacity": 1,
    "startText": "19:05", "endText": "19:08", "used": 2, "over": 1, "key": "1#1,4",
    "cues": [
      { "cueRef": 1, "code": "L1", "usage": 1, "status": "DONE" },
      { "cueRef": 4, "code": "L2", "usage": 1, "status": "PENDING" }
    ],
    "message": "共享资源「无线麦」容量 1 在 19:05-19:08 被占用 2（超额 1），相关提示项：「L1」占 1、「L2」占 1" }
]
```

口径：**跳过项不占用**；时段取已完成项的实际时段、已开始项「实际开始 → 顺延推算/预计结束」、未开始项顺延后待执行时段；**若窗口中全部相关提示项均已完成则该条不出现**；告警只提示，岗位登记照常成功（响应同步刷新 `resourceAlerts`）。

### 4. 顺延预演中的新增 / 消失 / 持续

`POST /api/live/whatif` 的请求不变（仍须携带 `versionId`、全部登记行 `rows[]` 与 `assumptions[]`）；响应在同岗位冲突字段之外新增：

```json
{
  "summary": {
    "baselineResourceAlertCount": 1, "scenarioResourceAlertCount": 2,
    "resourceAddedCount": 1, "resourceRemovedCount": 0, "resourceKeptCount": 1
  },
  "resourceAlertsAdded": [ { "resource": "无线麦", "startText": "19:08", "endText": "19:10", "message": "…" } ],
  "resourceAlertsRemoved": [],
  "resourceAlertsKept": [
    { "baseline": { "startText": "19:05", "endText": "19:08", "message": "…变更前消息…" },
      "scenario": { "startText": "19:05", "endText": "19:09", "message": "…变更后消息…" } }
  ]
}
```

告警以「资源 + 相关提示项引用集合」（`key`，如 `1#1,4`）稳定配对；预演只读，不改动容量、占用与任何登记。

### 5. 错误一览（均整体拒绝，不写入部分数据）

| 场景 | 状态码 | error |
| --- | --- | --- |
| 资源名称空 / 超长（>50 字） | 400 | `BAD_INPUT` |
| 容量非正整数（0 / 负数 / 小数 / 非数字） | 400 | `BAD_INPUT` |
| 资源重名（新增或改名） | 400 | `RESOURCE_NAME_EXISTS` |
| 资源不存在（改/删） | 404 | `NOT_FOUND` |
| 删除仍被引用的资源 | 409 | `RESOURCE_IN_USE`（`items` 逐项列出引用提示项） |
| 占用量非正整数 | 400 | `RESOURCE_USAGE_INVALID` |
| 提示项引用了已删除的资源（旧页面提交） | 400 | `RESOURCE_REF_INVALID` |
| 同一提示项重复引用同一资源 / `resources` 格式错误 | 400 | `BAD_INPUT` |
| 携带过期草稿版本号（资源与提示项一切写操作） | 409 | `VERSION_CONFLICT` |
| 资源超额时发布 | 422 | `PUBLISH_CONFLICT`（`errors` 中含 `RESOURCE_OVERLOAD` 明细） |

### 6. 冻结与旧版兼容

- 发布后在草稿中改名、改容量、增删占用或删除资源，**只影响后续发布的新版本**；已发布版本始终返回发布时冻结的 `resources` 与每行 `resourceUsages`，告警也按冻结值重算；
- **升级前已发布、没有资源数据的旧版本**：`resources` 为 `[]`、每行 `resourceUsages` 为 `[]`、`resourceAlerts` 为 `[]`，页面不显示资源列告警，行为与升级前完全一致；
- 数据库表 `draft_resources` / `draft_cue_resources` / `published_resources` / `published_cue_resources` 由建表脚本幂等创建（`CREATE TABLE IF NOT EXISTS`），旧库重启即自动补齐，不影响既有数据与启动流程。

## 十七、顺延变更待确认 API 调用示例（本轮新增）

联排现场的顺延若只显示在提示板上，岗位可能漏看。为此新增**顺延变更待确认留痕**：

- **何时留痕**：每次「岗位登记、舞监更正、跳过链、停排、恢复」使**当前执行版**某个**未开始、未跳过**提示项的**重算开始时刻**在同次操作前后发生变化时，系统按同次操作的前/后结果，为该项**所属岗位**留一条待确认记录；时刻未变化或操作后已开始 / 已完成 / 已跳过的项不留痕。
- **留什么**：冻结版本、提示项（编号 / 说明 / 岗位）、变更前后时刻、触发操作类型与可读说明、触发人及操作时间；**同次操作影响多项分别留痕**；操作事务整体失败（校验不通过、回滚）时不产生任何记录。
- **谁能看 / 确认**：执行账号只能查看与确认**自己当前有权负责岗位**的记录；**代班期间原账号失权、代班账号接手**（以确认当时的当班授权复核）。舞监可查看全部版本的全部记录及未确认数，但不能代确认。
- **确认协议**：确认须携带所见记录版本 `recordVersion`（待确认记录为 1，确认后为 2）；重复确认不重复留痕；版本归档（发布新版）或岗位权限变化时拒绝旧提交，且绝不误确认其他记录。
- **版本边界**：旧联排版本只读回看；**发布新版不承接**待确认（记录随旧版保存、不迁移）；新版初始无待确认记录。

触发操作 `triggerAction` 取值：`register`（岗位登记）、`correct`（舞监更正）、`skip`（跳过链）、`pause`（停排）、`resume`（恢复）。

### 1. 一次顺延操作后，各角色看到的清单

以本地默认端口 3000 为例（`curl -c/-b` 复用会话 Cookie）。第 1 版中灯光 L1（19:00–19:05）于 19:08 才完成，后继 S1 / P1 / L2 的重算开始由 19:05 / 19:10 顺延：

```bash
# 舞监登录
curl -c sm.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"username":"sm","password":"sm12345"}'
# 执行岗位登录
curl -c sound.cookie -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"username":"sound","password":"sound123"}'

# 舞监查看当前执行版全部待确认记录
curl -b sm.cookie -s http://localhost:3000/api/live/change-notices
```

响应（舞监 `scope=all`；含按岗位的未确认数）：

```json
{
  "versionId": 1, "versionNo": 1, "isLatest": true, "scope": "all",
  "myPositions": null,
  "total": 3, "pendingCount": 3,
  "positions": [
    { "position": "道具", "pendingCount": 1 },
    { "position": "灯光", "pendingCount": 1 },
    { "position": "音响", "pendingCount": 1 }
  ],
  "records": [
    {
      "id": 3, "versionId": 1, "versionNo": 1, "cueRef": 4,
      "code": "L2", "title": "追光主角上场", "position": "灯光",
      "beforeStart": 1150, "afterStart": 1151,
      "beforeStartText": "19:10", "afterStartText": "19:11", "deltaMinutes": 1,
      "triggerAction": "register",
      "triggerActionLabel": "岗位登记",
      "triggerDetail": "灯光执行 为「L1」登记实际完成",
      "triggerCueRef": 1, "triggerCueCode": "L1",
      "triggeredBy": "灯光执行", "triggeredAt": "2026-10-06 19:08:31",
      "acknowledged": false, "acknowledgedBy": null, "acknowledgedAt": null,
      "recordVersion": 1
    }
    /* S1（音响，19:05→19:08）、P1（道具，19:05→19:08）同批分别留痕 */
  ]
}
```

执行账号查询时 `scope=mine`，只返回自己当前负责岗位（含代班）的记录，并带 `myPositions`：

```bash
curl -b sound.cookie -s http://localhost:3000/api/live/change-notices
# {"scope":"mine","myPositions":["音响"],"total":1,"pendingCount":1,
#  "records":[{"id":1,"code":"S1","position":"音响","beforeStartText":"19:05","afterStartText":"19:08", ...}]}
```

清单排序：**待确认在前（id 倒序，新变更先确认），已确认在后**。

### 2. 岗位确认一条变更（携带所见 recordVersion）

```bash
curl -b sound.cookie -s -X POST \
  http://localhost:3000/api/live/change-notices/1/acknowledge \
  -H 'Content-Type: application/json' -d '{"recordVersion":1}'
```

成功返回更新后的该条记录（`acknowledged:true`、`recordVersion:2`、确认人 / 时间）及确认人视角的最新清单：

```json
{
  "notice": { "id": 1, "code": "S1", "acknowledged": true,
              "acknowledgedBy": "音响执行", "acknowledgedByUsername": "sound",
              "acknowledgedAt": "2026-10-06 19:10:02", "recordVersion": 2 },
  "versionId": 1, "pendingCount": 0, "records": [ /* 该账号可见的全部记录 */ ]
}
```

确认只推进该条记录自身版本，**不改动任何登记，也不影响重算**。

### 3. 代班期间原账号失权、代班账号接手

```bash
# 舞监让音响账号代班灯光岗位（仅当前执行版）
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/deputies \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"position":"灯光","username":"sound"}'

# 此后灯光原账号 light 查不到灯光记录（myPositions 为空），确认灯光记录 -> 403
curl -b light.cookie -s http://localhost:3000/api/live/change-notices
# {"scope":"mine","myPositions":[],"total":0,"pendingCount":0,"records":[]}
curl -b light.cookie -s -X POST \
  http://localhost:3000/api/live/change-notices/3/acknowledge \
  -H 'Content-Type: application/json' -d '{"recordVersion":1}'
# {"error":"NOTICE_FORBIDDEN_POSITION",
#  "message":"该顺延变更属于岗位「灯光」，你当前已不拥有该岗位的负责权（代班可能已变更），不能确认此记录"}

# 代班账号 sound 同时拥有音响与灯光，可确认灯光的 L2 记录
curl -b sound.cookie -s http://localhost:3000/api/live/change-notices
# {"myPositions":["音响","灯光"], ... }
curl -b sound.cookie -s -X POST \
  http://localhost:3000/api/live/change-notices/3/acknowledge \
  -H 'Content-Type: application/json' -d '{"recordVersion":1}'
# 200：ack L2 true 音响执行
```

撤销代班后原岗位账号恢复负责权；代班账号若再确认其代班期间岗位的新记录，同样 403。

### 4. 停排 / 恢复按「同次操作前后」分别留痕

```bash
# 19:30 停排：未开始项重算开始由各自顺延时刻被托到「不早于 19:30」
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/interruptions \
  -H 'Content-Type: application/json' \
  -d '{"versionId":1,"pauseText":"19:30","reason":"设备检修"}'
# 每条 pause 记录的 before 是停排生效前的重算开始，after 是停排中的最早开始（19:30 起）：
# triggerDetail 例：舞监 于 19:30 发起停排（原因：设备检修），未开始项重算开始不早于本次停排时刻

# 19:40 恢复：同次操作的 before=停排中时刻、after=恢复时刻托底，再为变化项留痕
curl -b sm.cookie -s -X POST http://localhost:3000/api/live/interruptions/resume \
  -H 'Content-Type: application/json' -d '{"versionId":1,"resumeText":"19:40"}'
# resume 记录例：P1 19:30 -> 19:40；triggerCueRef/triggerCueCode 为 null
```

跳过链同理：链中本次被标记为跳过的项**不为自己留痕**（操作后为 SKIPPED），只有链外仍未开始且重算开始因此回缩 / 变化的项留痕，`triggerDetail` 含根项、原因与新跳过项数。

### 5. 失败回滚不留痕、归档旧提交被拒绝、新版不承接

```bash
# 行版本过期 / 越权 / 停排期间登记等失败操作：事务整体回滚，不新增任何待确认记录
curl -b light.cookie -s -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"versionId":2,"cueRef":3,"rowVersion":99,"action":"start","time":"19:05"}'
# 409 VERSION_CONFLICT；/api/live/change-notices 的 total 不变

# 发布新版后，对旧版未确认记录的确认一律拒绝
curl -b props.cookie -s -X POST \
  http://localhost:3000/api/live/change-notices/5/acknowledge \
  -H 'Content-Type: application/json' -d '{"recordVersion":1}'
# {"error":"NOTICE_VERSION_ARCHIVED",
#  "message":"该顺延变更属于第 1 版，该版本已归档（当前为第 2 版），旧提交不能确认；记录可在该版本只读回看",
#  "currentVersionId":2}

# 旧版记录只读回看（执行账号仍只看自己在该版本的岗位；舞监看全部）
curl -b props.cookie -s http://localhost:3000/api/versions/1/change-notices
# {"isLatest":false,"scope":"mine","myPositions":["道具"], ...}

# 新版不承接待确认：当前执行版（第 2 版）清单为空
curl -b sm.cookie -s http://localhost:3000/api/live/change-notices
# {"total":0,"pendingCount":0,"records":[]}

# 版本列表含各版未确认数（舞监=全岗位，执行账号=本岗位）
curl -b sm.cookie -s http://localhost:3000/api/versions
# {"versions":[{"versionNo":2,"noticePendingCount":0},{"versionNo":1,"noticePendingCount":11}, ...]}
```

### 6. 错误一览

| 场景 | HTTP | `error` |
| --- | --- | --- |
| 未登录访问清单 / 确认 | 401 | `UNAUTHORIZED` |
| 舞监调用确认 | 403 | `FORBIDDEN`（顺延待确认由执行岗位确认，舞监仅查看） |
| 确认他人 / 已失权岗位的记录 | 403 | `NOTICE_FORBIDDEN_POSITION` |
| 提交的 `recordVersion` 与记录当前版本不符 | 409 | `NOTICE_STALE`（附 `currentRecordVersion`） |
| 对已确认记录再次确认（含用新版本号） | 409 | `NOTICE_ALREADY_ACKNOWLEDGED`（附确认人 / 时间，不重复留痕） |
| 记录所属版本已归档（发布了新版） | 409 | `NOTICE_VERSION_ARCHIVED` |
| 记录不存在 / 已随版本删除 | 404 | `NOT_FOUND` |
| 缺少整数记录 id / `recordVersion` | 400 | `BAD_INPUT` |

### 7. 兼容性与页面

- 表 `schedule_change_notices` 由建表脚本幂等创建（`CREATE TABLE IF NOT EXISTS`），旧库重启自动补齐；既有登记、更正、重算接口的请求与响应保持不变（`/api/versions` 列表仅**新增**字段 `noticePendingCount`）。
- 现场页新增「顺延变更待确认」面板：执行岗位看到自己负责岗位的待确认清单并逐条「确认」；舞监看到全部记录与各岗位未确认数（只读）。
- 「发布版本」回看页列出该版顺延变更记录（只读，归档版标注不能确认），版本列表新增「待确认」计数列。


