#!/usr/bin/env bun
/**
 * inline-claude CLI — interactive setup wizard
 * Usage: bunx inline-claude setup
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import * as readline from 'readline'

const STEPS = [
  'telegram-api',
  'userbot',
  'bot',
  'business',
  'env',
  'mcp-json',
  'test',
] as const

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve))

function print(s: string) { process.stdout.write(s + '\n') }
function hr() { print('\n' + '─'.repeat(50) + '\n') }

async function stepTelegramApi() {
  hr()
  print('Шаг 1/7 — Telegram API')
  print('')
  print('Нужен для userbot (доставляет тригеры в Claude).')
  print('')
  print('1. Открой https://my.telegram.org и войди')
  print('2. Перейди в "API development tools"')
  print('3. Создай приложение (название любое)')
  print('4. Сохрани api_id и api_hash')
  print('')
  const apiId = (await ask('Введи api_id: ')).trim()
  const apiHash = (await ask('Введи api_hash: ')).trim()
  if (!apiId || !apiHash) throw new Error('api_id и api_hash обязательны')
  return { apiId, apiHash }
}

async function stepUserbot(apiId: string, apiHash: string) {
  hr()
  print('Шаг 2/7 — Авторизация userbot')
  print('')
  const ubDir = join(homedir(), '.claude', 'userbot')
  const envPath = join(ubDir, '.env')

  if (!existsSync(ubDir)) {
    print(`Папка ${ubDir} не найдена.`)
    print('Создай её и скопируй туда auth.py из репо.')
    await ask('Нажми Enter когда готово...')
  }

  writeFileSync(envPath, `API_ID=${apiId}\nAPI_HASH=${apiHash}\n`, { flag: 'w' })
  print(`✅ Записал ${envPath}`)
  print('')
  print('Теперь запусти авторизацию:')
  print(`  cd ${ubDir}`)
  print('  pip install telethon python-dotenv')
  print('  python auth.py')
  print('')
  await ask('Сессия создана? Нажми Enter...')
}

async function stepBot() {
  hr()
  print('Шаг 3/7 — Создать Telegram бота')
  print('')
  print('1. Напиши @BotFather → /newbot')
  print('2. Придумай имя и username (должен заканчиваться на bot)')
  print('3. Сохрани токен вида 123456:AAxxxxxxx')
  print('4. /setinline → выбери бота → напиши подсказку (например: "Спроси Клода...")')
  print('5. /setinlinefeedback → выбери бота → 100%')
  print('')
  const token = (await ask('Введи токен бота: ')).trim()
  const botUsername = (await ask('Введи username бота (без @): ')).trim()
  if (!token) throw new Error('Токен обязателен')
  return { token, botUsername: botUsername || '' }
}

async function stepBusiness() {
  hr()
  print('Шаг 4/7 — Business Bot (опционально, нужен Telegram Premium)')
  print('')
  const hasPremium = (await ask('У тебя есть Telegram Premium? (да/нет): ')).trim().toLowerCase()
  if (!hasPremium.startsWith('д')) {
    print('Пропускаем — Business Bot можно добавить позже.')
    return false
  }
  print('')
  print('1. Telegram → Настройки → Telegram Business → Чат-боты')
  print('2. Найди своего бота')
  print('3. Включи "Может отвечать" (Can reply)')
  print('')
  await ask('Готово? Нажми Enter...')
  return true
}

async function stepEnv(token: string, botUsername: string) {
  hr()
  print('Шаг 5/7 — Настройка .env')
  print('')
  print('Узнать свой Telegram ID можно у @userinfobot — напиши ему любое сообщение.')
  print('')
  const ownerId = (await ask('Введи свой Telegram ID: ')).trim()
  if (!ownerId) throw new Error('OWNER_ID обязателен')

  const installDir = join(homedir(), '.claude', 'inline-bot')
  const envPath = join(installDir, '.env')
  const bridgeTarget = botUsername ? `@${botUsername}` : ''

  const envContent = [
    `INLINE_BOT_TOKEN=${token}`,
    `OWNER_ID=${ownerId}`,
    bridgeTarget ? `BRIDGE_TARGET=${bridgeTarget}` : '# BRIDGE_TARGET=@your_bot',
    '# INLINE_ALLOW_IDS=  # comma-separated ids for guest Q&A access',
  ].join('\n') + '\n'

  writeFileSync(envPath, envContent)
  print(`✅ Записал ${envPath}`)
  return { ownerId }
}

async function stepMcpJson() {
  hr()
  print('Шаг 6/7 — Подключить к Claude Code')
  print('')
  const installDir = join(homedir(), '.claude', 'inline-bot')
  const projectDir = (await ask('Путь к папке проекта Claude Code (Enter = текущая): ')).trim() || process.cwd()

  const mcpJson = {
    mcpServers: {
      'inline-claude': {
        command: 'bun',
        args: ['run', '--cwd', installDir, '--silent', 'start'],
      },
    },
  }

  const mcpPath = join(projectDir, '.mcp.json')
  let existing: Record<string, unknown> = {}
  if (existsSync(mcpPath)) {
    try { existing = JSON.parse(readFileSync(mcpPath, 'utf8')) } catch {}
  }
  const merged = { ...existing, mcpServers: { ...(existing.mcpServers as Record<string, unknown> ?? {}), ...mcpJson.mcpServers } }
  writeFileSync(mcpPath, JSON.stringify(merged, null, 2) + '\n')
  print(`✅ Записал ${mcpPath}`)
  print('')
  print('Перезапусти Claude Code сессию.')
}

async function stepTest(botUsername: string) {
  hr()
  print('Шаг 7/7 — Первый тест')
  print('')
  print(`1. В любом Telegram чате напиши @${botUsername || 'твой_бот'} привет`)
  print('2. Выбери карточку — должно появиться "🤔 Клод думает…"')
  print('3. Claude должен ответить')
  print('')
  print('Для Business Bot: напиши в личный чат "Клод, привет"')
  print('')
  print('✅ Установка завершена!')
}

async function main() {
  const cmd = process.argv[2]

  if (cmd !== 'setup') {
    print('inline-claude — Telegram inline + Business Bot MCP сервер')
    print('')
    print('Команды:')
    print('  bunx inline-claude setup   — интерактивная установка')
    print('  bun run start              — запустить сервер')
    print('')
    print('Документация: https://github.com/benzin8/inline-claude-public')
    rl.close()
    return
  }

  print('╔══════════════════════════════════════╗')
  print('║  inline-claude — Установка           ║')
  print('╚══════════════════════════════════════╝')
  print('')
  print('Проведу тебя через 7 шагов. После каждого жди подтверждения.')

  try {
    const { apiId, apiHash } = await stepTelegramApi()
    await stepUserbot(apiId, apiHash)
    const { token, botUsername } = await stepBot()
    await stepBusiness()
    await stepEnv(token, botUsername)
    await stepMcpJson()
    await stepTest(botUsername)
  } catch (e) {
    print(`\n❌ Ошибка: ${e instanceof Error ? e.message : e}`)
    print('Попробуй снова: bunx inline-claude setup')
  } finally {
    rl.close()
  }
}

main()
