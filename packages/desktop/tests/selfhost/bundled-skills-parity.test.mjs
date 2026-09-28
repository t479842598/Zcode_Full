import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// 仓库路径含空格与中文（外置卷），不能用 URL.pathname——那会留下 %20 编码。
const rootDir = fileURLToPath(new URL("../../../..", import.meta.url));
const root = new URL("../../../..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const abs = (path) => join(rootDir, path);

const BOOTSTRAP = "apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts";
const SEA_SCRIPT = "apps/zcode-cli/packages/cli/scripts/sea-bundled-skill-assets.mjs";
const SKILLS_DIR = "apps/zcode-cli/packages/bundled-skills/skills";

/** ZCode 的技能 frontmatter 校验上限：adapters/src/skills/index.ts → MAX_DESCRIPTION_LENGTH。 */
const MAX_DESCRIPTION_LENGTH = 1024;

/** 从 bootstrap 的 TS 数组里抽出 `"skills/.../SKILL.md"` 字面量（含模板串形式的三条）。 */
function extractBootstrapPaths(source) {
  const block = source.match(
    /export const BUNDLED_SKILL_PACK_REQUIRED_PATHS = \[([\s\S]*?)\] as const;/u,
  );
  assert.ok(block, "未找到 BUNDLED_SKILL_PACK_REQUIRED_PATHS");
  const out = [];
  for (const line of block[1].split("\n")) {
    const trimmed = line.trim().replace(/,$/u, "");
    const quoted = trimmed.match(/^"(skills\/[^"]+)"$/u);
    if (quoted) {
      out.push(quoted[1]);
      continue;
    }
    // 三条 dynamic-workflows 用模版串引用 DYNAMIC_WORKFLOW_SKILL_NAME，其值就是常量名本身。
    const templated = trimmed.match(/^`skills\/\$\{DYNAMIC_WORKFLOW_SKILL_NAME\}\/([^`]+)`$/u);
    if (templated) out.push(`skills/dynamic-workflows/${templated[1]}`);
  }
  return out;
}

/** 从 SEA 脚本里抽出同形的纯字符串数组。 */
function extractSeaPaths(source) {
  const block = source.match(/export const bundledSkillPackRequiredPaths = \[([\s\S]*?)\];/u);
  assert.ok(block, "未找到 bundledSkillPackRequiredPaths");
  return [...block[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
}

test("两份 required paths 清单逐字一致（防漂移）", async () => {
  const bootstrap = extractBootstrapPaths(await read(BOOTSTRAP));
  const sea = extractSeaPaths(await read(SEA_SCRIPT));
  assert.deepEqual(
    bootstrap,
    sea,
    "bootstrap 与 SEA 打包脚本的 required paths 不一致 —— " +
      "漏改任一份会让 SEA 构建与运行时校验对技能包的要求不同步",
  );
  assert.ok(bootstrap.length > 3, "除 dynamic-workflows 外还应包含红队技能");
});

test("每条 required path 在磁盘上真实存在", async () => {
  const paths = extractBootstrapPaths(await read(BOOTSTRAP));
  const missing = [];
  for (const relative of paths) {
    try {
      await stat(abs(join("apps/zcode-cli/packages/bundled-skills", relative)));
    } catch {
      missing.push(relative);
    }
  }
  assert.deepEqual(missing, [], `缺失必需资产，整包会被拒: ${missing.join(", ")}`);
});

test("红队技能齐备（23 个）且每个都有独立目录", async () => {
  const entries = await readdir(abs(SKILLS_DIR), { withFileTypes: true });
  const redteam = entries.filter((e) => e.isDirectory() && e.name.startsWith("redteam-"));
  assert.equal(redteam.length, 23, `红队技能应为 23 个，实际 ${redteam.length}`);
  const declared = extractBootstrapPaths(await read(BOOTSTRAP)).filter((p) =>
    p.startsWith("skills/redteam-"),
  );
  assert.equal(declared.length, 23, "required paths 里也应登记 23 个红队技能");
});

test("每个红队技能的 frontmatter 可被 ZCode 解析（name/description 齐备且 name 等于目录名）", async () => {
  const entries = await readdir(abs(SKILLS_DIR), { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("redteam-"));
  const problems = [];

  for (const dir of dirs) {
    const raw = await read(`apps/zcode-cli/packages/bundled-skills/skills/${dir.name}/SKILL.md`);
    if (!raw.startsWith("---\n")) {
      problems.push(`${dir.name}: 缺少 frontmatter`);
      continue;
    }
    const end = raw.indexOf("\n---\n", 3);
    if (end < 0) {
      problems.push(`${dir.name}: frontmatter 未闭合`);
      continue;
    }
    const fm = raw.slice(4, end);
    // 复刻 parseFlatYaml：按第一个冒号切分，值取其后全部内容并 trim。
    const values = {};
    for (const line of fm.split("\n")) {
      if (!line.trim() || line.trim().startsWith("#") || /^\s/u.test(line)) continue;
      const sep = line.indexOf(":");
      if (sep <= 0) {
        problems.push(`${dir.name}: 非法 frontmatter 行「${line}」`);
        continue;
      }
      values[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
    }
    // 复刻 parseScalar：只剥最外层成对引号，不处理转义。
    const scalar = (v) => {
      if (v === undefined) return undefined;
      const t = v.trim();
      if (!t.length) return undefined;
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1).trim();
      }
      return t;
    };

    const name = scalar(values.name);
    const description = scalar(values.description);
    if (!name) problems.push(`${dir.name}: skill_missing_name`);
    else if (name !== dir.name) problems.push(`${dir.name}: name「${name}」与目录名不符`);
    if (!description) problems.push(`${dir.name}: skill_missing_description`);
    else if (description.length > MAX_DESCRIPTION_LENGTH) {
      problems.push(`${dir.name}: skill_description_too_long (${description.length})`);
    }
    // 反斜杠转义不会被 parseScalar 还原，出现即说明生成时用了错误的引号策略
    if (description?.includes("\\")) problems.push(`${dir.name}: description 含反斜杠转义`);
    if (scalar(values.when_to_use)?.includes("\\")) {
      problems.push(`${dir.name}: when_to_use 含反斜杠转义`);
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("每个红队技能都带 ZCode 口径的工具依赖提示", async () => {
  const entries = await readdir(abs(SKILLS_DIR), { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("redteam-"));
  const missing = [];
  for (const dir of dirs) {
    const raw = await read(`apps/zcode-cli/packages/bundled-skills/skills/${dir.name}/SKILL.md`);
    // 正文引用了 redteam_* 工具与 $DSH_HOME/redteam/*.sh，这些属 DSH 插件、未移植。
    // 没有这段提示，模型会去调不存在的工具。
    if (!raw.includes("工具依赖提示")) missing.push(dir.name);
  }
  assert.deepEqual(missing, [], `缺少依赖提示: ${missing.join(", ")}`);
});

test("技能名全局唯一（同名会让 skill_duplicate_name 拒绝加载）", async () => {
  const entries = await readdir(abs(SKILLS_DIR), { withFileTypes: true });
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (seen.has(entry.name)) seen.set(entry.name, seen.get(entry.name) + 1);
    else seen.set(entry.name, 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(dupes, [], `重复技能目录: ${JSON.stringify(dupes)}`);
});
