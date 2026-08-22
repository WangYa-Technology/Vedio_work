# 运行数据库维护规范

## 唯一主数据库

应用运行时使用 `data/db2.sqlite`，路径由 `src/utils/db.ts` 中的 `getPath("db2.sqlite")` 决定。

以下文件不是主数据库，不能用来恢复项目数据：

- `data/data.db`
- `data/db.sqlite`
- `data/serve/db.sqlite`

这些路径可能由打包、旧版本或目录初始化留下，出现 0 字节是正常的；不要把它们当作数据备份提交。

## 拉取和提交前检查

本地数据库包含项目、剧本、资产、分镜和视频记录，不能直接用上游同名文件覆盖。同步 `wangya/main` 前：

```bash
cp -p Toonflow-app/data/db2.sqlite \
  Toonflow-app/backups/db2-before-sync-$(date +%Y%m%d-%H%M%S).sqlite
git fetch wangya main
git diff --name-status HEAD wangya/main -- Toonflow-app/data/db2.sqlite
```

如果上游新增、替换或删除 `data/db2.sqlite`，必须先确认数据库不是占位库，再决定是否合并。提交前运行：

```bash
cd Toonflow-app
npm run check:runtime-db
```

该检查会验证 SQLite 完整性、必要表和业务记录数量；空库只适用于全新安装，不适用于包含现有项目的运行数据提交。

## 本次事故记录（2026-08-22）

上游提交 `c33ef6b` 将原本未跟踪的本地 `db2.sqlite` 变成了已跟踪文件，并带入一个只有表结构、没有项目记录的数据库。快进合并后，本地项目数据被替换；随后 `c1bd7de` 又提交了该空数据库。恢复时使用了本机备份 `db2.sqlite.before-minimax-h3-aieverything-20260819.sqlite`，并由当前版本启动迁移补齐新字段。

恢复前的空数据库保存在 `Toonflow-app/backups/db2-before-restore-20260822-1712.sqlite`，仅作安全回滚使用，不作为业务数据源。
