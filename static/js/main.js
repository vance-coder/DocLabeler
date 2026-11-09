/**
 * 应用装配入口。
 *
 * 各 UI 模块在被 import 时把自己的函数注册到 state.js 的 actions 上；
 * 模块之间不互相 import，避免循环依赖。shortcuts.js 必须放在最后——
 * 它在顶层绑定事件时会立即读取 actions 上的函数引用。
 */

import { actions } from "./state.js";
import "./history.js";
import "./projects_view.js";
import "./shell.js";
import "./case_list.js";
import "./thumbs.js";
import "./bulk.js";
import "./panes.js";
import "./case_view.js";
import "./case_panels.js";
import "./saving.js";
import "./evidence.js";
import "./review.js";
import "./metrics.js";
import "./top_actions.js";
import "./presentation.js";
import "./shortcuts.js";

actions.route();
