/**
 * English language pack
 */
const en: Record<string, string> = {
    // ========================
    // Common
    // ========================
    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.close': 'Close',
    'common.loading': 'Loading...',
    'common.refresh': 'Refresh',
    'common.search': 'Search',
    'common.edit': 'Edit',
    'common.add': 'Add',
    'common.enable': 'Enable',
    'common.disable': 'Disable',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.none': 'None',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.error': 'Error',
    'common.success': 'Success',
    'common.save_config': 'Save Config',
    'common.save_success': '✅ Saved',
    'common.save_failed': 'Save failed',
    'common.test_connection': 'Test Connection',
    'common.prev_page': 'Previous',
    'common.next_page': 'Next',

    // ========================
    // App Loading
    // ========================
    'app.loading': 'Agent is initializing…',

    // ========================
    // Setup Wizard
    // ========================
    'setup.welcome': 'Welcome to OpenFlux',
    'setup.subtitle': 'Complete the following setup to start using your AI assistant',
    'setup.step_assistant': 'AI Assistant',
    'setup.step_brain': 'AI Brain',
    'setup.step_cloud': 'Enterprise',
    'setup.step_remote': 'Remote Control',
    'setup.skip': 'Skip Setup',
    'setup.prev': 'Previous',
    'setup.next': 'Next',
    'setup.finish': 'Get Started',
    // Step 1
    'setup.name_title': 'Name your AI assistant',
    'setup.name_label': 'Assistant Name',
    'setup.name_default': 'OpenFlux Assistant',
    'setup.name_placeholder': 'e.g. Jarvis, Alex...',
    'setup.persona_label': 'Persona (optional)',
    'setup.persona_placeholder': 'Describe your AI assistant\'s personality...',
    'setup.persona_hint': 'Leave empty for default persona, can be changed later',
    // Step 2
    'setup.brain_title': 'Choose AI Brain',
    'setup.provider_label': 'Model Provider',
    'setup.apikey_label': 'API Key',
    'setup.apikey_required': '* Required',
    'setup.apikey_placeholder': 'Enter your API Key',
    'setup.model_label': 'Model Name',
    'setup.model_custom_placeholder': 'Enter custom model name',
    'setup.baseurl_label': 'Base URL (optional)',
    'setup.baseurl_placeholder': 'Custom API endpoint',
    // Step 3
    'setup.cloud_title': 'Enterprise Connection (optional)',
    'setup.cloud_desc': 'Connect to OpenFlux Cloud for cloud-based agents. All local features work without connection.',
    'setup.cloud_enable': 'Connect to OpenFlux Cloud',
    'setup.cloud_user_label': 'Username',
    'setup.cloud_user_placeholder': 'Cloud account',
    'setup.cloud_pass_label': 'Password',
    'setup.cloud_pass_placeholder': 'Cloud password',
    'setup.cloud_hint': 'Skip to configure later in Settings',
    // Step 4
    'setup.remote_title': 'Remote Control (optional)',
    'setup.remote_desc': 'Enable to chat with AI remotely via Feishu, WeChat, etc.',
    'setup.remote_enable': 'Enable OpenFluxRouter Remote Control',
    'setup.router_url_label': 'Router URL',
    'setup.remote_hint': 'Skip to configure later in Settings',

    // ========================
    // Title Bar
    // ========================
    'titlebar.status_ready': 'Ready',
    'titlebar.artifacts': 'Artifacts Panel',
    'titlebar.theme_toggle': 'Toggle Theme',
    'titlebar.launch_browser': 'Launch Debug Browser',
    'titlebar.feedback': 'Feedback',

    // Feedback
    'feedback.title': 'Feedback',
    'feedback.type': 'Type',
    'feedback.type_bug': 'Bug Report',
    'feedback.type_feature': 'Feature Request',
    'feedback.type_business': 'Business Inquiry',
    'feedback.field_title': 'Title',
    'feedback.title_placeholder': 'Briefly describe the issue or suggestion',
    'feedback.field_content': 'Description',
    'feedback.content_placeholder': 'Please describe in detail...',
    'feedback.field_contact': 'Contact (optional)',
    'feedback.contact_placeholder': 'Email or other contact info',
    'feedback.anonymous': 'Submit anonymously',
    'feedback.attachments': 'Attachments (optional, max 6, ≤10MB each)',
    'feedback.add_file': '+ Add File',
    'feedback.cancel': 'Cancel',
    'feedback.submit': 'Submit',
    'feedback.submitting': 'Submitting...',
    'feedback.success': 'Feedback submitted. Thank you!',
    'feedback.error_title': 'Please enter a title',
    'feedback.error_content': 'Please enter a description',
    'feedback.error_file_count': 'Max 6 attachments allowed',
    'feedback.error_file_size': 'File too large (max 10MB): ',
    'titlebar.minimize': 'Minimize',
    'titlebar.maximize': 'Maximize',
    'titlebar.close': 'Close',

    // ========================
    // Sidebar
    // ========================
    'sidebar.collapse': 'Collapse Sidebar',
    'sidebar.search': 'Search Sessions',
    'sidebar.search_placeholder': 'Search sessions...',
    'sidebar.new_chat': 'New Chat',
    'sidebar.new_agent': 'New Agent',
    'sidebar.scheduler': 'Scheduled Tasks',
    'sidebar.settings': 'Settings',
    'sidebar.agent_login_text': 'Sign in to Nexus AI Cloud<br />Access team-level Agents and standard workflows',
    'sidebar.agent_login_btn': 'Sign In',

    // ========================
    // Chat / Workspace
    // ========================
    'chat.welcome_title': 'Welcome to OpenFlux',
    'chat.welcome_desc': 'I\'m your AI assistant, ready to help you with various tasks',
    'chat.input_placeholder': 'Ask OpenFlux...',
    'chat.send': 'Send',
    'chat.mic': 'Voice Input',
    'chat.voice_mode': 'Live Voice Chat',
    'chat.recording': 'Recording...',
    'chat.thinking': 'Thinking',
    'chat.reasoning': 'Reasoning',
    'chat.tool_calling': 'Calling tools',
    'chat.generating': 'Generating...',
    'chat.copy_code': 'Copy Code',
    'chat.copy_message': 'Copy Message',
    'chat.retry': 'Retry',
    'chat.stop': 'Stop Generation',

    // ========================
    // Settings - Tabs
    // ========================
    'settings.title': 'Settings',
    'settings.tab_general': 'General',
    'settings.tab_models': 'Models',
    'settings.tab_tools': 'Tools',
    'settings.tab_memory': 'Memory',
    'settings.tab_agent': 'Agent',
    'settings.tab_connections': 'Router',

    // ========================
    // Settings - Client Tab
    // ========================
    'settings.output_dir': 'Output Directory',
    'settings.output_dir_desc': 'Default save location for Agent-generated files',
    'settings.output_browse': 'Browse',
    'settings.output_reset': 'Reset Default',
    'settings.debug_mode': 'Debug Mode',
    'settings.debug_mode_desc': 'Show Gateway real-time logs at the bottom',
    'settings.voice_section': 'Voice',
    'settings.voice_unavailable': 'Voice is unavailable. Voice model needs to be downloaded first.',
    'settings.tts_autoplay': 'Auto-read Replies',
    'settings.tts_autoplay_desc': 'Automatically play voice after assistant replies',
    'settings.tts_voice': 'Voice',
    'settings.tts_voice_desc': 'TTS voice for reading',
    'settings.language': 'Language',
    'settings.language_desc': 'Switch client display language',
    'settings.appearance_section': 'Appearance & Language',
    'settings.advanced_section': 'Advanced',
    'settings.security_section': 'Security & Sandbox',

    // ========================
    // Settings - Server Tab
    // ========================
    'settings.model_config': 'Model Configuration',
    'settings.orch_model': 'Orchestration Model',
    'settings.orch_model_desc': 'Main Agent reasoning, task planning and routing',
    'settings.exec_model': 'Execution Model',
    'settings.exec_model_desc': 'SubAgent tool calls and subtask execution',
    'settings.embed_model': 'Embedding Model',
    'settings.embed_model_desc': 'Memory vectorization, changing model requires rebuilding database',
    'settings.provider_label': 'Provider',
    'settings.model_label': 'Model',
    'settings.provider_keys': 'Provider Keys',
    'settings.web_section': 'Web Search & Fetch',
    'settings.web_search': 'Web Search',
    'settings.web_search_desc': 'Agent searches the internet for real-time information',
    'settings.search_provider': 'Search Provider',
    'settings.search_apikey': 'API Key',
    'settings.search_apikey_placeholder': 'Enter Search API Key...',
    'settings.search_max_results': 'Max Results',
    'settings.web_fetch': 'Web Fetch',
    'settings.web_fetch_desc': 'Scrape web page content for Agent analysis',
    'settings.fetch_readability': 'Readability Extraction',
    'settings.fetch_max_chars': 'Max Characters',
    'settings.mcp_section': 'MCP External Tools',
    'settings.mcp_desc': 'Connect external tool servers via MCP protocol to extend Agent capabilities',
    'settings.mcp_add': 'Add MCP Server',
    'settings.mcp_form_title_add': 'Add MCP Server',
    'settings.mcp_form_title_edit': 'Edit MCP Server',
    'settings.mcp_name': 'Name',
    'settings.mcp_name_placeholder': 'e.g. my-tools',
    'settings.mcp_location': 'Run Location',
    'settings.mcp_location_server': 'Server (Gateway machine)',
    'settings.mcp_location_client': 'Client (local)',
    'settings.mcp_transport': 'Transport',
    'settings.mcp_transport_stdio': 'stdio (local command)',
    'settings.mcp_transport_sse': 'SSE (remote service)',
    'settings.mcp_command': 'Command',
    'settings.mcp_command_placeholder': 'e.g. npx, python',
    'settings.mcp_args': 'Arguments',
    'settings.mcp_args_placeholder': 'Space-separated, e.g. -m my_server --port 8080',
    'settings.mcp_env': 'Environment Variables',
    'settings.mcp_env_placeholder': 'KEY=VALUE space-separated',
    'settings.mcp_url': 'Server URL',
    'settings.mcp_url_placeholder': 'http://localhost:8080/sse',
    'settings.sandbox_section': 'Sandbox Isolation',
    'settings.sandbox_mode': 'Execution Mode',
    'settings.sandbox_mode_desc': 'local: code hardening only (default) / docker: container isolation',
    'settings.sandbox_local': 'Local',
    'settings.sandbox_docker': 'Docker',
    'settings.docker_config': 'Docker Configuration',
    'settings.docker_config_desc': 'Build image first: docker build -f Dockerfile.sandbox -t openflux-sandbox .',
    'settings.docker_image': 'Image Name',
    'settings.docker_memory': 'Memory Limit',
    'settings.docker_cpu': 'CPU Limit',
    'settings.docker_network': 'Network Mode',
    'settings.docker_network_none': 'No Network (none)',
    'settings.docker_network_bridge': 'Bridge',
    'settings.docker_network_host': 'Host',
    'settings.blocked_ext': 'Blocked File Types',
    'settings.blocked_ext_desc': 'Comma-separated, e.g. exe,bat,ps1,cmd',
    'settings.gateway_section': 'Gateway',
    'settings.gateway_mode': 'Work Mode',
    'settings.gateway_mode_desc': 'Gateway service runtime mode',
    'settings.gateway_embedded': 'Embedded',
    'settings.gateway_port': 'Port',
    'settings.gateway_port_desc': 'WebSocket service listening port',
    'settings.embed_rebuilding': 'Rebuilding memory index...',
    'settings.embed_rebuild_hint': 'Do not close the application, this may take a while for large datasets',
    'settings.provider_custom': 'Custom',
    'settings.provider_ollama_local': 'Ollama (Local)',
    'settings.provider_zhipu': 'Zhipu (GLM)',
    'settings.show_hide': 'Show/Hide',

    // ========================
    // Settings - Memory Tab
    // ========================
    'memory.distill_title': '🌙 Memory Distillation',
    'memory.micro_cards': 'Micro Cards',
    'memory.mini_cards': 'Mini Cards',
    'memory.macro_cards': 'Macro Cards',
    'memory.topics': 'Topics',
    'memory.scheduler_disabled': 'Scheduler not enabled',
    'memory.distill_enable': 'Enable Distillation',
    'memory.distill_period': 'Distillation Period',
    'memory.quality_threshold': 'Quality Threshold',
    'memory.session_density': 'Session Density Threshold',
    'memory.similarity_threshold': 'Similarity Threshold',
    'memory.manual_distill': '⚡ Manual Distill',
    'memory.tab_all': 'All',
    'memory.no_cards': 'No memory cards yet',
    'memory.disabled_notice': 'Memory system is not enabled. Configure <code>memory.enabled: true</code> in openflux.yaml',
    'memory.search_placeholder': 'Search memories (semantic + keyword)...',
    'memory.clear_search': 'Clear search',
    'memory.empty_loading': 'Loading...',
    'memory.clear_all': 'Clear All Memories',
    'memory.system_info': 'System Info',
    'memory.system_info_title': 'Memory System Info',
    'memory.total_count': 'Total Memories',
    'memory.db_size': 'Database Size',
    'memory.vector_dim': 'Vector Dimensions',
    'memory.embed_model': 'Embedding Model',
    'memory.confirm_delete': 'Are you sure you want to delete this memory?',
    'memory.confirm_clear_all': 'Are you sure you want to clear all memories? This action cannot be undone!',
    'memory.confirm_manual_distill': 'Are you sure you want to run memory distillation now? This ignores time window settings.',

    // ========================
    // Settings - Agent Tab
    // ========================
    'agent.basic_section': 'Basic Settings',
    'agent.name_label': 'Agent Name',
    'agent.name_desc': 'Display name for the assistant, used when user asks "who are you"',
    'agent.name_placeholder': 'e.g. Alex',
    'agent.prompt_label': 'Global System Prompt',
    'agent.prompt_desc': 'Custom global system prompt defining the assistant\'s personality, rules and expertise. Applies to all agents.',
    'agent.prompt_placeholder': 'e.g. You are a personal assistant named Alex, warm and meticulous, skilled in schedule management...',
    'agent.model_section': 'Agent Models',
    'agent.model_independent': 'Independent Model Config',
    'agent.model_independent_desc': 'Assign independent models per Agent, falls back to global Orchestration model if not set',
    'agent.skills_section': 'Skills',
    'agent.skills_label': 'Professional Skills',
    'agent.skills_desc': 'Add professional knowledge and skill instructions. Enabled skills are injected into the system prompt.',
    'agent.add_skill': 'Add Skill',

    // ========================
    // Settings - Cloud Tab
    // ========================
    'cloud.account_title': 'NexusAI Account',
    'cloud.not_logged': 'Not logged in — Sign in via the sidebar button',
    'cloud.logout': 'Sign Out',
    'cloud.router_title': 'OpenFluxRouter Message Routing',
    'cloud.router_url': 'Router URL',
    'cloud.router_url_desc': 'OpenFluxRouter WebSocket endpoint',
    'cloud.router_url_placeholder': 'ws://host:8080/ws/app',
    'cloud.app_id': 'App ID',
    'cloud.app_id_desc': 'Application ID registered in Router',
    'cloud.app_id_placeholder': 'Application ID',
    'cloud.app_type': 'App Type',
    'cloud.app_type_desc': 'Application type identifier',
    'cloud.api_key': 'API Key',
    'cloud.api_key_desc': 'Bearer Token for Router authentication',
    'cloud.app_user_id': 'App User ID',
    'cloud.app_user_id_desc': 'User identifier for this instance (auto-generated)',
    'cloud.app_user_id_placeholder': 'Auto-generated',
    'cloud.regenerate': 'Regenerate',
    'cloud.enable_connection': 'Enable Connection',
    'cloud.enable_connection_desc': 'Auto-connect to Router when enabled',
    'cloud.status_disconnected': 'Disconnected',
    // ========================
    // Scheduler
    // ========================
    'scheduler.title': 'Scheduled Tasks',
    'scheduler.empty': 'No scheduled tasks',
    'scheduler.empty_hint': 'Create via chat: "Every day at 9am, help me..."',
    'scheduler.runs': 'Execution History',
    'scheduler.no_runs': 'No execution records',

    // ========================
    // Router Bind
    // ========================
    'router.bind_text': 'Binding required to receive messages',
    'router.bind_placeholder': 'Enter pairing code',
    'router.bind_btn': 'Bind',
    'router.disconnected': 'Disconnected',

    // ========================
    // Voice Overlay
    // ========================
    'voice.title': 'Voice Chat',
    'voice.exit': 'Exit Voice Chat',
    'voice.click_start': 'Click to start',
    'voice.listening': 'Listening...',
    'voice.speaking': 'Speaking...',
    'voice.processing': 'Processing...',

    // ========================
    // File Preview
    // ========================
    'preview.open_default': 'Open with default app',
    'preview.show_in_folder': 'Show in folder',
    'preview.copy_content': 'Copy content',

    // ========================
    // Confirm Modal
    // ========================
    'confirm.title': 'Confirm Action',
    'confirm.message': 'Are you sure you want to proceed?',

    // ========================
    // Login Modal
    // ========================
    'login.title': 'NexusAI Login',
    'login.username_label': 'Username / Email',
    'login.username_placeholder': 'Enter NexusAI account',
    'login.password_label': 'Password',
    'login.password_placeholder': 'Enter password',
    'login.btn': 'Sign In',

    // ========================
    // Debug Panel
    // ========================
    'debug.copy_all': 'Copy all logs',
    'debug.clear': 'Clear logs',

    // ========================
    // Model Labels
    // ========================
    'model.custom': '✏️ Custom...',
    'model.latest': 'Latest',
    'model.multimodal': 'Multimodal',
    'model.vision': 'Vision',

    // ========================
    // Connection Status
    // ========================
    'status.connecting': 'Connecting...',
    'status.connected': 'Connected',
    'status.disconnected': 'Disconnected',
    'status.reconnecting': 'Reconnecting...',
    'status.error': 'Connection Error',

    // ========================
    // Misc
    // ========================
    'misc.saved': '✓ Saved',
    'misc.save_failed': 'Save failed',
    'misc.confirm_delete': 'Confirm delete?',
    'misc.confirm_clear_memory': 'Clear all memories? This cannot be undone.',
    'misc.no_sessions': 'No sessions',
    'misc.delete_session': 'Delete Session',
    'misc.today': 'Today',
    'misc.yesterday': 'Yesterday',
    'misc.earlier': 'Earlier',

    // ========================
    // Dynamic TS Text (main.ts)
    // ========================
    'setup.saving': 'Saving...',
    'setup.finish_done': 'Setup Complete',
    'setup.save_failed': 'Setup save failed: {0}',
    'app.timeout': 'Startup timeout, please restart the application',
    'app.init_agent': 'Agent is initializing…',
    'app.loading_core': 'Loading core modules… ({0}s)',
    'app.init_service': 'Initializing services… ({0}s)',
    'app.waiting_gateway': 'Waiting for Gateway to start... ({0}s)',
    'app.gateway_timeout': 'Gateway startup timeout, please restart the application',
    'app.gateway_not_connected': 'Gateway not connected',
    'app.no_audio_received': 'No audio data received',
    'app.tts_request_failed': 'TTS request failed',
    'app.running': 'Running...',
    'app.completed': 'Completed',
    'app.steps': 'steps',
    'chat.cloud_login_hint': 'Cloud Agent session, please login to OpenFlux first...',
    'app.new_session': 'New Session',
    'app.confirm_delete_session': 'Are you sure you want to delete this session? This action cannot be undone.',
    'app.more_actions': 'More actions',
    'app.router_channel': 'OpenFluxRouter Message Channel',
    'app.router_messages': 'Router Messages',
    'embed.progress_done': '100% (Done)',
    'mcp.edit_title': 'Edit MCP Server',
    'mcp.add_title': 'Add MCP Server',
    'settings.saving': 'Saving...',
    'settings.save_failed_detail': 'Save failed: {0}',
    'settings.restart_hint': 'Please close and restart the application for changes to take effect.',
    'agent.saving': 'Saving...',
    'agent.save_failed_detail': 'Save failed: {0}',
    'agent.no_skills': 'No skills yet, click the button below to add',
    'chat.recognizing': 'Recognizing...',
    'chat.generating_title': 'Generating...',
    'voice.recognizing': 'Recognizing...',
    'voice.thinking': 'Thinking...',
    'voice.replying': 'Replying... (speak to interrupt)',
    'preview.loading': 'Loading...',
    'preview.load_failed': 'Load failed',
    'memory.load_failed': 'Load failed',
    'memory.search_failed': 'Search failed',
    'memory.distill_saving': 'Saving...',
    'memory.distill_saved': '✅ Saved',
    'memory.distill_save_failed': '❌ {0}',
    'memory.distill_running': '⏳ Distilling...',
    'memory.distill_done': '✅ Distillation complete',
    'memory.distill_failed': '❌ {0}',
    'login.saving': 'Signing in...',
    'login.enter_credentials': 'Please enter username and password',
    'login.failed': 'Login failed: {0}',
    'router.enter_code': '❗ Please enter pairing code',
    'router.binding': 'Binding...',
    'router.bind_success': '✅ Bound successfully',
    'router.bind_failed': '❌ Bind failed: {0}',
    'router.testing': 'Testing...',
    'router.test_success': '✅ Connection successful',
    'router.test_failed': '❌ Connection failed',
    'router.save_success': '✅ Saved',
    'cloud.agent_no_room': 'No chat room available for this Agent',
    'cloud.chat_failed': 'Failed to start cloud chat: {0}',
    'cloud.no_agents': 'No Agents',
    'cloud.agent_group': 'NexusAi Cloud',
    'cloud.waiting_messages': 'Waiting for inbound messages...',
    'scheduler.no_runs_inline': 'No execution records',
    'router.sending': '⭐ Sending...',
    'router.waiting_pair': '⏳ Pairing code submitted, waiting for the other party...',
    'router.bind_error': '❌ Bind failed',
    'router.already_bound': '✅ Already bound',

    // ========================
    // Model Labels (extended)
    // ========================
    'model.highspeed': 'High Speed',
    'model.reasoning': 'Reasoning',

    // ========================
    // Working Mode
    // ========================
    'mode.title': 'Working Mode',
    'mode.standalone': 'Standalone',
    'mode.standalone_desc': 'Local config + optional NexusAI',
    'mode.router': 'Team Mode',
    'mode.router_desc': 'Router-managed config',
    'mode.managed': 'Managed',
    'mode.managed_desc': 'NexusAI fully managed + audit',
    'mode.managed_by_router': '🔒 Managed by Router',
    'mode.managed_by_nexus': '🔒 Managed by NexusAI',

    // ========================
    // Settings UI (dynamic)
    // ========================
    'settings.gateway_remote': 'Remote Mode',
    'settings.key_configured': 'Configured',
    'settings.key_not_configured': 'Not Configured',
    'settings.enter_apikey': 'Enter API Key...',

    // ========================
    // MCP (dynamic)
    // ========================
    'mcp.status_connected': 'Connected',
    'mcp.status_error': 'Connection Failed',
    'mcp.status_disconnected': 'Disconnected',
    'mcp.client_badge': 'Client',
    'mcp.tools_unit': 'tools',

    // ========================
    // Agent / Skills (dynamic)
    // ========================
    'agent.unnamed_skill': 'Unnamed Skill',
    'agent.delete_skill': 'Delete Skill',
    'agent.skill_title_placeholder': 'Skill Title',
    'agent.skill_content_placeholder': 'Skill content (Markdown), describe expertise, procedures or behavior rules...',
    'agent.follow_global': 'Follow Global',
    'agent.not_set': 'Not Set',
    'agent.enter_model_name': 'Enter model name',

    // Agent Edit Form
    'agent.create_title': 'Create Agent',
    'agent.edit_title_edit': 'Edit Agent',
    'agent.section_basic': 'Basic Info',
    'agent.section_appearance': 'Appearance',
    'agent.section_prompt': 'System Prompt',
    'agent.id_label': 'ID',
    'agent.id_hint': 'Unique identifier, cannot be changed after creation',
    'agent.desc_label': 'Description',
    'agent.desc_placeholder': 'Short description of the Agent',
    'agent.icon_label': 'Icon',
    'agent.upload_photo': 'Upload Photo',
    'agent.color_label': 'Theme Color',
    'agent.prompt_placeholder_agent': 'Optional: Define the Agent\'s role, behavior and capabilities',
    'agent.image_too_large': 'Image must be under 200KB',
    'agent.back': 'Back',

    // ========================
    // Progress Card (dynamic)
    // ========================
    'app.thinking': 'Thinking...',

    // ========================
    // Chat (dynamic)
    // ========================
    'chat.tts_read': 'Read Aloud',

    // ========================
    // Common (extended)
    // ========================
    'common.remove': 'Remove',
    'common.unknown_error': 'Unknown error',
    'common.load_failed': 'Load failed',
    'common.failed': 'Failed',

    // ========================
    // Preview (extended)
    // ========================
    'preview.open': 'Open',
    'preview.save_as': 'Save As',
    'preview.code': 'Code',
    'preview.output_result': 'Output Result',
    'preview.open_hint': 'Click the button above to open with default app',
    'preview.video_hint': 'Video file, please open with default app',
    'preview.unsupported_type': 'This file type requires default app to open',
    'preview.unsupported_preview': 'This file type cannot be previewed',
    'preview.open_or_saveas': 'Click the button above to open or save as',
    'preview.preview_failed': 'Preview failed',
    'preview.parse_failed': '(Parse failed)',
    'preview.slide': 'Slide',
    'preview.page': 'Page',
    'preview.no_text': '(No text content)',

    // ========================
    // Scheduler (extended)
    // ========================
    'scheduler.pause': 'Pause',
    'scheduler.resume': 'Resume',
    'scheduler.trigger': 'Run Now',
    'scheduler.running': 'Running',
    'scheduler.back_to_list': 'Back to List',

    // ========================
    // Voice (extended)
    // ========================
    'voice.unavailable': 'Voice recognition unavailable (model not loaded)',
    'voice.chat_unavailable': 'Voice chat unavailable (model not loaded)',
    'voice.not_recognized': 'No speech recognized',
    'voice.mic_failed': 'Microphone access failed',
    'voice.recognition_failed': 'Recognition failed',
    'voice.process_failed': 'Voice processing failed',

    // ========================
    // Memory (extended)
    // ========================
    'memory.no_match': 'No matching memories',
    'memory.empty': 'No memories yet',
    'memory.tags_label': 'Tags',
    'memory.distill_in_progress': 'Distillation in progress...',
    'memory.distill_window': 'Currently in distillation window',
    'memory.distill_idle': 'Idle',
    'memory.distill_window_label': 'Window',
    'memory.distill_last': 'Last',
    'memory.cards_unit': 'cards',
    'memory.uncategorized': 'Uncategorized',
    'memory.delete_card': 'Delete Card',
    'memory.topic_label': 'Topic',
    'memory.quality_label': 'Quality',

    // ========================
    // Cloud / Router (extended)
    // ========================
    'cloud.managed_config': 'Router Managed Config',
    'cloud.shared_model': 'Shared Model',
    'cloud.shared_model_desc': 'Model config and API Key managed by Router',
    'cloud.daily_usage': 'Today Usage',
    'cloud.use_managed': 'Use Managed Config',
    'cloud.use_managed_desc': 'When enabled, uses Router-provided model and Key instead of local config',
    'cloud.unlimited': 'Unlimited',
    'cloud.connected_to_agent': 'Connected to cloud Agent',
    'cloud.api_key_configured': 'Configured (click to modify)',
    'cloud.fill_router_info': 'Please fill in Router URL and App ID',
    'cloud.router_not_configured': 'Router not connected or shared model not configured',
    'login.failed_short': 'Login failed',

    // ========================
    // Tool progress text
    // ========================
    'tool.type_content': 'Type content',
    'tool.keyboard_input': 'Keyboard input',
    'tool.send_notification': 'Send notification',
    'tool.dispatch_subtask': 'Dispatch subtask',

    // ========================
    // Debug (extended)
    // ========================
    'debug.log_lines': 'log lines',

    // ========================
    // Artifact categories
    // ========================
    'artifact.cat_all': 'All',
    'artifact.cat_document': 'Docs',
    'artifact.cat_code': 'Code',
    'artifact.cat_image': 'Images',
    'artifact.cat_data': 'Data',
    'artifact.cat_media': 'Media',
    'artifact.cat_other': 'Other',
};

export default en;
