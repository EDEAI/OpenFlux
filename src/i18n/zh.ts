/**
 * Chinese (Simplified) language pack
 * 中文（简体）语言包
 */
const zh: Record<string, string> = {
    // ========================
    // Common
    // ========================
    'common.confirm': '确认',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.delete': '删除',
    'common.close': '关闭',
    'common.loading': '加载中...',
    'common.refresh': '刷新',
    'common.search': '搜索',
    'common.edit': '编辑',
    'common.add': '添加',
    'common.enable': '启用',
    'common.disable': '禁用',
    'common.yes': '是',
    'common.no': '否',
    'common.none': '无',
    'common.copy': '复制',
    'common.copied': '已复制',
    'common.error': '错误',
    'common.success': '成功',
    'common.save_config': '保存配置',
    'common.save_success': '✅ 已保存',
    'common.save_failed': '保存失败',
    'common.test_connection': '测试连接',
    'common.prev_page': '上一页',
    'common.next_page': '下一页',

    // ========================
    // App Loading
    // ========================
    'app.loading': '智能体正在初始化…',

    // ========================
    // Setup Wizard
    // ========================
    'setup.welcome': '欢迎使用 OpenFlux',
    'setup.subtitle': '完成以下设置，即可开始使用你的 AI 助手',
    'setup.step_assistant': 'AI 助手',
    'setup.step_brain': 'AI 大脑',
    'setup.step_cloud': '企业端',
    'setup.step_remote': '远程操控',
    'setup.skip': '跳过设置',
    'setup.prev': '上一步',
    'setup.next': '下一步',
    'setup.finish': '开始使用',
    // Step 1
    'setup.name_title': '给你的 AI 助手起个名字',
    'setup.name_label': '助手名称',
    'setup.name_default': 'OpenFlux 助手',
    'setup.name_placeholder': '例如：小助、Jarvis...',
    'setup.persona_label': '人设（可选）',
    'setup.persona_placeholder': '描述你的 AI 助手的性格特点...',
    'setup.persona_hint': '不设置则使用默认人设，安装后可随时修改',
    // Step 2
    'setup.brain_title': '选择 AI 大脑',
    'setup.provider_label': '模型供应商',
    'setup.apikey_label': 'API Key',
    'setup.apikey_required': '*必填',
    'setup.apikey_placeholder': '输入你的 API Key',
    'setup.model_label': '模型名称',
    'setup.model_custom_placeholder': '输入自定义模型名称',
    'setup.baseurl_label': 'Base URL（可选）',
    'setup.baseurl_placeholder': '自定义 API 地址',
    // Step 3
    'setup.cloud_title': '企业端连接（可选）',
    'setup.cloud_desc': '连接 OpenFlux 云端可使用云端智能体。不连接也可正常使用所有本地功能。',
    'setup.cloud_enable': '连接 OpenFlux 云端',
    'setup.cloud_user_label': '账号',
    'setup.cloud_user_placeholder': '云端账号',
    'setup.cloud_pass_label': '密码',
    'setup.cloud_pass_placeholder': '云端密码',
    'setup.cloud_hint': '跳过可在安装后随时在设置中配置',
    // Step 4
    'setup.remote_title': '远程操控（可选）',
    'setup.remote_desc': '启用后可通过飞书、微信等平台远程与 AI 对话。',
    'setup.remote_enable': '启用 OpenFluxRouter 远程操控',
    'setup.router_url_label': 'Router 地址',
    'setup.remote_hint': '跳过可在安装后随时在设置中配置',

    // ========================
    // Title Bar
    // ========================
    'titlebar.status_ready': '就绪',
    'titlebar.artifacts': '成果物面板',
    'titlebar.theme_toggle': '切换主题',
    'titlebar.launch_browser': '启动调试浏览器',
    'titlebar.minimize': '最小化',
    'titlebar.maximize': '最大化',
    'titlebar.close': '关闭',

    // ========================
    // Sidebar
    // ========================
    'sidebar.collapse': '收起侧边栏',
    'sidebar.search': '搜索会话',
    'sidebar.search_placeholder': '搜索会话...',
    'sidebar.new_chat': '发起新对话',
    'sidebar.new_agent': '新建 Agent',
    'sidebar.scheduler': '定时任务',
    'sidebar.settings': '设置',
    'sidebar.agent_login_text': '登录 Nexus Ai 云端<br />获取团队级 Agent 和标准业务流程',
    'sidebar.agent_login_btn': '登录',

    // ========================
    // Chat / Workspace
    // ========================
    'chat.welcome_title': '欢迎使用 OpenFlux',
    'chat.welcome_desc': '我是你的 AI 助手，可以帮你完成各种任务',
    'chat.input_placeholder': '问问 OpenFlux...',
    'chat.send': '发送',
    'chat.mic': '语音输入',
    'chat.voice_mode': '实时语音对话',
    'chat.recording': '录音中...',
    'chat.thinking': '思考中',
    'chat.reasoning': '推理中',
    'chat.tool_calling': '正在调用工具',
    'chat.generating': '生成中...',
    'chat.copy_code': '复制代码',
    'chat.copy_message': '复制消息',
    'chat.retry': '重试',
    'chat.stop': '停止生成',

    // ========================
    // Settings - Tabs
    // ========================
    'settings.title': '设置',
    'settings.tab_general': '通用',
    'settings.tab_models': '模型',
    'settings.tab_tools': '工具',
    'settings.tab_memory': '记忆',
    'settings.tab_agent': '智能体',
    'settings.tab_connections': '连接',

    // ========================
    // Settings - Client Tab
    // ========================
    'settings.output_dir': '输出目录',
    'settings.output_dir_desc': 'Agent 生成文件的默认保存位置',
    'settings.output_browse': '浏览',
    'settings.output_reset': '重置默认',
    'settings.debug_mode': 'Debug 模式',
    'settings.debug_mode_desc': '在底部显示 Gateway 实时日志',
    'settings.voice_section': '语音',
    'settings.voice_unavailable': '语音功能当前不可用，需要下载语音模型后才能使用',
    'settings.tts_autoplay': '自动朗读回复',
    'settings.tts_autoplay_desc': '助手回复完成后自动播放语音',
    'settings.tts_voice': '语音角色',
    'settings.tts_voice_desc': 'TTS 朗读使用的语音',
    'settings.language': '界面语言',
    'settings.language_desc': '切换客户端显示语言',
    'settings.appearance_section': '外观与语言',
    'settings.advanced_section': '高级',
    'settings.security_section': '安全与沙箱',

    // ========================
    // Settings - Server Tab
    // ========================
    'settings.model_config': '模型配置',
    'settings.orch_model': '编排模型',
    'settings.orch_model_desc': '主 Agent 推理、任务规划和路由决策',
    'settings.exec_model': '执行模型',
    'settings.exec_model_desc': 'SubAgent 工具调用和子任务执行',
    'settings.embed_model': '嵌入模型 (Embedding)',
    'settings.embed_model_desc': '记忆系统向量化，更换模型需要重建数据库',
    'settings.provider_label': '供应商',
    'settings.model_label': '模型',
    'settings.provider_keys': '供应商密钥',
    'settings.web_section': 'Web 搜索与获取',
    'settings.web_search': 'Web 搜索',
    'settings.web_search_desc': 'Agent 搜索互联网获取实时信息',
    'settings.search_provider': '搜索提供商',
    'settings.search_apikey': 'API Key',
    'settings.search_apikey_placeholder': '输入搜索 API Key...',
    'settings.search_max_results': '最大结果数',
    'settings.web_fetch': '网页获取',
    'settings.web_fetch_desc': '抓取网页正文内容供 Agent 分析',
    'settings.fetch_readability': 'Readability 提取',
    'settings.fetch_max_chars': '最大字符数',
    'settings.mcp_section': 'MCP 外部工具',
    'settings.mcp_desc': '通过 MCP 协议连接外部工具服务器，扩展 Agent 能力',
    'settings.mcp_add': '添加 MCP Server',
    'settings.mcp_form_title_add': '添加 MCP Server',
    'settings.mcp_form_title_edit': '编辑 MCP Server',
    'settings.mcp_name': '名称',
    'settings.mcp_name_placeholder': '例如: my-tools',
    'settings.mcp_location': '运行位置',
    'settings.mcp_location_server': '服务端（Gateway 机器）',
    'settings.mcp_location_client': '客户端（本机）',
    'settings.mcp_transport': '传输方式',
    'settings.mcp_transport_stdio': 'stdio（本地命令）',
    'settings.mcp_transport_sse': 'SSE（远程服务）',
    'settings.mcp_command': '命令',
    'settings.mcp_command_placeholder': '例如: npx, python',
    'settings.mcp_args': '参数',
    'settings.mcp_args_placeholder': '空格分隔，例如: -m my_server --port 8080',
    'settings.mcp_env': '环境变量',
    'settings.mcp_env_placeholder': 'KEY=VALUE 空格分隔',
    'settings.mcp_url': '服务器 URL',
    'settings.mcp_url_placeholder': 'http://localhost:8080/sse',
    'settings.sandbox_section': '沙盒隔离',
    'settings.sandbox_mode': '执行模式',
    'settings.sandbox_mode_desc': 'local: 仅代码加固（默认） / docker: 容器隔离',
    'settings.sandbox_local': '本地 (local)',
    'settings.sandbox_docker': 'Docker',
    'settings.docker_config': 'Docker 配置',
    'settings.docker_config_desc': '需先构建镜像: docker build -f Dockerfile.sandbox -t openflux-sandbox .',
    'settings.docker_image': '镜像名',
    'settings.docker_memory': '内存限制',
    'settings.docker_cpu': 'CPU 限制',
    'settings.docker_network': '网络模式',
    'settings.docker_network_none': '断网 (none)',
    'settings.docker_network_bridge': '桥接 (bridge)',
    'settings.docker_network_host': '宿主机 (host)',
    'settings.blocked_ext': '禁止写入的文件类型',
    'settings.blocked_ext_desc': '以逗号分隔，如 exe,bat,ps1,cmd',
    'settings.gateway_section': 'Gateway',
    'settings.gateway_mode': '工作模式',
    'settings.gateway_mode_desc': 'Gateway 服务运行方式',
    'settings.gateway_embedded': '内嵌模式',
    'settings.gateway_port': '端口',
    'settings.gateway_port_desc': 'WebSocket 服务监听端口',
    'settings.embed_rebuilding': '正在重建记忆索引...',
    'settings.embed_rebuild_hint': '请勿关闭程序，数据量大时可能耗时较长',
    'settings.provider_custom': '自定义',
    'settings.provider_ollama_local': 'Ollama (本地)',
    'settings.provider_zhipu': '智谱 (Zhipu)',
    'settings.show_hide': '显示/隐藏',

    // ========================
    // Settings - Memory Tab
    // ========================
    'memory.distill_title': '🌙 记忆蒸馏系统',
    'memory.micro_cards': 'Micro 卡片',
    'memory.mini_cards': 'Mini 卡片',
    'memory.macro_cards': 'Macro 卡片',
    'memory.topics': '主题',
    'memory.scheduler_disabled': '调度器未启用',
    'memory.distill_enable': '启用蒸馏',
    'memory.distill_period': '蒸馏时段',
    'memory.quality_threshold': '质量阈值',
    'memory.session_density': '会话密度阈值',
    'memory.similarity_threshold': '相似度阈值',
    'memory.manual_distill': '⚡ 手动蒸馏',
    'memory.tab_all': '全部',
    'memory.no_cards': '暂无记忆卡片',
    'memory.disabled_notice': '记忆系统未启用。请在 openflux.yaml 中配置 <code>memory.enabled: true</code>',
    'memory.search_placeholder': '搜索记忆（语义 + 关键词）...',
    'memory.clear_search': '清除搜索',
    'memory.empty_loading': '加载中...',
    'memory.clear_all': '清空所有记忆',
    'memory.system_info': '系统信息',
    'memory.system_info_title': '记忆系统信息',
    'memory.total_count': '总记忆数',
    'memory.db_size': '数据库大小',
    'memory.vector_dim': '向量维度',
    'memory.embed_model': '嵌入模型',
    'memory.confirm_delete': '确定删除这条记忆？',
    'memory.confirm_clear_all': '确定清空所有记忆？此操作不可恢复！',
    'memory.confirm_manual_distill': '确定要立即执行记忆蒸馏？此操作不受时段限制。',

    // ========================
    // Settings - Agent Tab
    // ========================
    'agent.basic_section': '基本设定',
    'agent.name_label': '智能体名称',
    'agent.name_desc': '设置助手的显示名称，用户问"你是谁"时会使用此名称',
    'agent.name_placeholder': '例如：小明',
    'agent.prompt_label': '全局角色设定',
    'agent.prompt_desc': '自定义全局系统提示，定义助手的人设、行为规则和专业领域。此设定对所有智能体生效',
    'agent.prompt_placeholder': '例如：你是一个名叫小明的私人助理，性格温和、细心，擅长日程管理和信息整理...',
    'agent.model_section': 'Agent 模型',
    'agent.model_independent': '独立模型配置',
    'agent.model_independent_desc': '为每个 Agent 指定独立模型，不设置则使用全局 Orchestration 模型',
    'agent.skills_section': '技能',
    'agent.skills_label': '专业技能',
    'agent.skills_desc': '为智能体添加专业知识和技能指令，启用的技能会注入系统提示词',
    'agent.add_skill': '添加技能',

    // ========================
    // Settings - Cloud Tab
    // ========================
    'cloud.account_title': 'OpenFlux 云端账户',
    'cloud.not_logged': '未登录 — 请通过侧边栏底部按钮登录',
    'cloud.logout': '登出',
    'cloud.router_title': 'OpenFluxRouter 消息路由',
    'cloud.router_url': 'Router 地址',
    'cloud.router_url_desc': 'OpenFluxRouter WebSocket 端点',
    'cloud.router_url_placeholder': 'ws://host:8080/ws/app',
    'cloud.app_id': 'App ID',
    'cloud.app_id_desc': '在 Router 中注册的应用 ID',
    'cloud.app_id_placeholder': '应用 ID',
    'cloud.app_type': 'App Type',
    'cloud.app_type_desc': '应用类型标识',
    'cloud.api_key': 'API Key',
    'cloud.api_key_desc': '用于 Router 认证的 Bearer Token',
    'cloud.app_user_id': 'App User ID',
    'cloud.app_user_id_desc': '本实例的用户标识（自动生成）',
    'cloud.app_user_id_placeholder': '自动生成',
    'cloud.regenerate': '重新生成',
    'cloud.enable_connection': '启用连接',
    'cloud.enable_connection_desc': '开启后自动连接 Router',
    'cloud.status_disconnected': '未连接',
    // ========================
    // Scheduler
    // ========================
    'scheduler.title': '定时任务',
    'scheduler.empty': '暂无定时任务',
    'scheduler.empty_hint': '通过对话创建："每天9点帮我..."',
    'scheduler.runs': '执行记录',
    'scheduler.no_runs': '暂无执行记录',

    // ========================
    // Router Bind
    // ========================
    'router.bind_text': '需要绑定后才能接收消息',
    'router.bind_placeholder': '输入配对码',
    'router.bind_btn': '绑定',
    'router.disconnected': '未连接',

    // ========================
    // Voice Overlay
    // ========================
    'voice.title': '语音对话',
    'voice.exit': '退出语音对话',
    'voice.click_start': '点击开始对话',
    'voice.listening': '聆听中...',
    'voice.speaking': '说话中...',
    'voice.processing': '处理中...',

    // ========================
    // File Preview
    // ========================
    'preview.open_default': '用默认应用打开',
    'preview.show_in_folder': '在文件夹中显示',
    'preview.copy_content': '复制内容',

    // ========================
    // Confirm Modal
    // ========================
    'confirm.title': '操作确认',
    'confirm.message': '确认执行此操作？',

    // ========================
    // Login Modal
    // ========================
    'login.title': 'OpenFlux 云端登录',
    'login.username_label': '用户名 / 邮箱',
    'login.username_placeholder': '输入 OpenFlux 账号',
    'login.password_label': '密码',
    'login.password_placeholder': '输入密码',
    'login.btn': '登录',

    // ========================
    // Debug Panel
    // ========================
    'debug.copy_all': '复制所有日志',
    'debug.clear': '清空日志',

    // ========================
    // Model Labels
    // ========================
    'model.custom': '✏️ 自定义...',
    'model.latest': '最新',
    'model.multimodal': '多模态',
    'model.vision': '视觉',

    // ========================
    // Connection Status
    // ========================
    'status.connecting': '连接中...',
    'status.connected': '已连接',
    'status.disconnected': '连接断开',
    'status.reconnecting': '重连中...',
    'status.error': '连接错误',

    // ========================
    // Misc
    // ========================
    'misc.saved': '✓ 已保存',
    'misc.save_failed': '保存失败',
    'misc.confirm_delete': '确认删除？',
    'misc.confirm_clear_memory': '确认清空所有记忆？此操作不可撤销。',
    'misc.no_sessions': '暂无会话',
    'misc.delete_session': '删除会话',
    'misc.today': '今天',
    'misc.yesterday': '昨天',
    'misc.earlier': '更早',

    // ========================
    // Dynamic TS Text (main.ts)
    // ========================
    'setup.saving': '保存中...',
    'setup.finish_done': '完成设置',
    'setup.save_failed': '设置保存失败: {0}',
    'app.timeout': '启动超时，请重启应用',
    'app.init_agent': '智能体正在初始化…',
    'app.loading_core': '正在加载核心模块… ({0}s)',
    'app.init_service': '正在初始化服务… ({0}s)',
    'app.waiting_gateway': '等待 Gateway 启动... ({0}s)',
    'app.gateway_timeout': 'Gateway 启动超时，请重启应用',
    'app.gateway_not_connected': 'Gateway 未连接',
    'app.no_audio_received': '未收到音频数据',
    'app.tts_request_failed': 'TTS 请求失败',
    'app.running': '运行中...',
    'app.completed': '完成',
    'app.steps': '步',
    'chat.cloud_login_hint': '当前为云端 Agent 会话，请先登录 OpenFlux...',
    'app.new_session': '新会话',
    'app.confirm_delete_session': '确定删除此会话？此操作不可撤销？',
    'app.more_actions': '更多操作',
    'app.router_channel': 'OpenFluxRouter 消息通道',
    'app.router_messages': 'Router 消息',
    'embed.progress_done': '100% (完成)',
    'mcp.edit_title': '编辑 MCP Server',
    'mcp.add_title': '添加 MCP Server',
    'settings.saving': '保存中...',
    'settings.save_failed_detail': '保存失败: {0}',
    'settings.restart_hint': '请手动关闭并重新启动应用以使更改生效。',
    'agent.saving': '保存中...',
    'agent.save_failed_detail': '保存失败: {0}',
    'agent.no_skills': '暂无技能，点击下方按钮添加',
    'chat.recognizing': '识别中...',
    'chat.generating_title': '正在生成...',
    'voice.recognizing': '识别中...',
    'voice.thinking': '思考中...',
    'voice.replying': '回复中... (说话可打断)',
    'preview.loading': '加载中...',
    'preview.load_failed': '加载失败',
    'memory.load_failed': '加载失败',
    'memory.search_failed': '搜索失败',
    'memory.distill_saving': '保存中...',
    'memory.distill_saved': '✅ 已保存',
    'memory.distill_save_failed': '❌ {0}',
    'memory.distill_running': '⏳ 蒸馏中...',
    'memory.distill_done': '✅ 蒸馏完成',
    'memory.distill_failed': '❌ {0}',
    'login.saving': '登录中...',
    'login.enter_credentials': '请输入用户名和密码',
    'login.failed': '登录失败: {0}',
    'router.enter_code': '❗ 请输入配对码',
    'router.binding': '绑定中...',
    'router.bind_success': '✅ 绑定成功',
    'router.bind_failed': '❌ 绑定失败: {0}',
    'router.testing': '测试中...',
    'router.test_success': '✅ 连接成功',
    'router.test_failed': '❌ 连接失败',
    'router.save_success': '✅ 已保存',
    'cloud.agent_no_room': '该 Agent 无可用聊天室',
    'cloud.chat_failed': '发起云端聊天失败: {0}',
    'cloud.no_agents': '暂无 Agent',
    'cloud.agent_group': 'NexusAi 云端',
    'cloud.waiting_messages': '等待入站消息...',
    'scheduler.no_runs_inline': '暂无执行记录',
    'router.sending': '⭐ 发送中...',
    'router.waiting_pair': '⏳ 配对码已提交，等待对方提交相同配对码...',
    'router.bind_error': '❌ 绑定失败',
    'router.already_bound': '✅ 已存在绑定关系',

    // ========================
    // Model Labels (extended)
    // ========================
    'model.highspeed': '高速',
    'model.reasoning': '推理',

    // ========================
    // Settings UI (dynamic)
    // ========================
    'settings.gateway_remote': '远程模式',
    'settings.key_configured': '已配置',
    'settings.key_not_configured': '未配置',
    'settings.enter_apikey': '输入 API Key...',

    // ========================
    // MCP (dynamic)
    // ========================
    'mcp.status_connected': '已连接',
    'mcp.status_error': '连接失败',
    'mcp.status_disconnected': '未连接',
    'mcp.client_badge': '客户端',
    'mcp.tools_unit': '工具',

    // ========================
    // Agent / Skills (dynamic)
    // ========================
    'agent.unnamed_skill': '未命名技能',
    'agent.delete_skill': '删除技能',
    'agent.skill_title_placeholder': '技能标题',
    'agent.skill_content_placeholder': '技能内容（Markdown 格式），描述专业知识、操作步骤或行为规则...',
    'agent.follow_global': '跟随全局',
    'agent.not_set': '未设置',
    'agent.enter_model_name': '输入模型名称',

    // Agent Edit Form
    'agent.create_title': '创建 Agent',
    'agent.edit_title_edit': '编辑 Agent',
    'agent.section_basic': '基本信息',
    'agent.section_appearance': '外观',
    'agent.section_prompt': '系统提示词',
    'agent.id_label': 'ID',
    'agent.id_hint': '唯一标识，创建后不可修改',
    'agent.desc_label': '描述',
    'agent.desc_placeholder': 'Agent 的简短描述',
    'agent.icon_label': '图标',
    'agent.upload_photo': '上传照片',
    'agent.color_label': '主题色',
    'agent.prompt_placeholder_agent': '可选：定义 Agent 的角色、行为和能力范围',
    'agent.image_too_large': '图片不能超过 200KB',
    'agent.back': '返回',

    // ========================
    // Progress Card (dynamic)
    // ========================
    'app.thinking': '思考中...',

    // ========================
    // Chat (dynamic)
    // ========================
    'chat.tts_read': '朗读',

    // ========================
    // Common (extended)
    // ========================
    'common.remove': '移除',
    'common.unknown_error': '未知错误',
    'common.load_failed': '加载失败',
    'common.failed': '失败',

    // ========================
    // Preview (extended)
    // ========================
    'preview.open': '打开',
    'preview.save_as': '另存为',
    'preview.code': '代码',
    'preview.output_result': '输出结果',
    'preview.open_hint': '点击上方按钮用默认应用打开',
    'preview.video_hint': '视频文件，请用默认应用打开',
    'preview.unsupported_type': '该文件类型请用默认应用打开',
    'preview.unsupported_preview': '该文件类型不支持预览',
    'preview.open_or_saveas': '点击上方按钮用默认应用打开或另存为',
    'preview.preview_failed': '预览失败',
    'preview.parse_failed': '(解析失败)',
    'preview.slide': '幻灯片',
    'preview.page': '第',
    'preview.no_text': '(无文字内容)',

    // ========================
    // Scheduler (extended)
    // ========================
    'scheduler.pause': '暂停',
    'scheduler.resume': '恢复',
    'scheduler.trigger': '立即执行',
    'scheduler.running': '执行中',
    'scheduler.back_to_list': '返回列表',

    // ========================
    // Voice (extended)
    // ========================
    'voice.unavailable': '语音识别不可用（模型未加载）',
    'voice.chat_unavailable': '语音对话不可用（模型未加载）',
    'voice.not_recognized': '未识别到语音',
    'voice.mic_failed': '麦克风访问失败',
    'voice.recognition_failed': '识别失败',
    'voice.process_failed': '语音处理失败',

    // ========================
    // Memory (extended)
    // ========================
    'memory.no_match': '未找到匹配记忆',
    'memory.empty': '暂无记忆',
    'memory.tags_label': '标签',
    'memory.distill_in_progress': '蒸馏进行中...',
    'memory.distill_window': '当前处于蒸馏窗口',
    'memory.distill_idle': '空闲',
    'memory.distill_window_label': '窗口',
    'memory.distill_last': '上次',
    'memory.cards_unit': '张',
    'memory.uncategorized': '未分类',
    'memory.delete_card': '删除卡片',
    'memory.topic_label': '主题',
    'memory.quality_label': '质量',

    // ========================
    // Cloud / Router (extended)
    // ========================
    'cloud.managed_config': 'Router 托管配置',
    'cloud.shared_model': '共享模型',
    'cloud.shared_model_desc': '由 Router 统一管理的模型配置和 API Key',
    'cloud.daily_usage': '今日用量',
    'cloud.use_managed': '使用托管配置',
    'cloud.use_managed_desc': '启用后将使用 Router 下发的模型和 Key，替代本地配置',
    'cloud.unlimited': '无限制',
    'cloud.connected_to_agent': '已连接到云端 Agent',
    'cloud.api_key_configured': '已配置（点击修改）',
    'cloud.fill_router_info': '请填写 Router 地址和 App ID',
    'cloud.router_not_configured': '未连接 Router 或 Router 未配置共享模型',
    'login.failed_short': '登录失败',

    // ========================
    // Tool progress text
    // ========================
    'tool.type_content': '输入内容',
    'tool.keyboard_input': '键盘输入',
    'tool.send_notification': '发送通知',
    'tool.dispatch_subtask': '派发子任务',

    // ========================
    // Debug (extended)
    // ========================
    'debug.log_lines': '条日志',

    // ========================
    // Artifact categories
    // ========================
    'artifact.cat_all': '全部',
    'artifact.cat_document': '文档',
    'artifact.cat_code': '代码',
    'artifact.cat_image': '图片',
    'artifact.cat_data': '数据',
    'artifact.cat_media': '媒体',
    'artifact.cat_other': '其他',
};

export default zh;
