"""进程内的项目级写入锁。

单进程 uvicorn 下，schema 版本检查、标注迁移、导入、导出发布这类「读-改-写」
复合操作必须整体串行，否则两个并发请求可能各自通过版本检查，写出互相覆盖的结果。

约定（不要反序，否则会死锁）：

    项目锁 locks.project_lock(proj)  ->  单条 case 锁 store._lock_for(case)

项目锁是 ``RLock``：路由层先拿项目锁，再进入 ``store.save_annotation`` 拿 case 锁，
同一线程重入不会自锁。锁 key 用项目根目录的绝对解析路径，跨工作区也不会串。
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

_guard = threading.Lock()
_locks: dict[str, threading.RLock] = {}


def project_lock(project_or_root: Any) -> threading.RLock:
    """返回某个项目根目录下的可重入锁；对同一路径永远返回同一把锁。

    ``Path`` 自己也有 ``.root``（盘符），所以必须先区分「路径」与「Project 对象」，
    否则所有项目会共用 ``D:\\`` 这把锁，且与按项目对象取的锁不是同一把。
    """
    if isinstance(project_or_root, (str, Path)):
        root = project_or_root
    else:
        root = getattr(project_or_root, "root", project_or_root)
    key = str(Path(root).resolve())
    with _guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _locks[key] = lock
        return lock
