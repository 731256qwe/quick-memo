import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'quick-memo'
export const inject = ['tools', 'llm']

const PROMPT = (transcript) =>
  `把下面这段话整理成 JSON，只返回 JSON 本身，不要 markdown 代码块，不要任何解释。字段：type（“待办”或“备忘”）、time（ISO 格式，没有就省略）、people（字符串数组，没有就省略）、location（没有就省略）、content（一句话概括核心事项）。原始文字：${transcript}`

/** Parse the model reply, retrying once after stripping a markdown fence. */
function parseMemo(text) {
  const raw = text.trim()
  try {
    return JSON.parse(raw)
  } catch {
    const unfenced = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    return JSON.parse(unfenced)
  }
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'quick_memo',
      description: '把口语文字整理成结构化速记 JSON',
      parameters: {
        transcript: {
          type: 'string',
          required: true,
          description: '要整理的口语文字。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            type: { type: 'string', required: true },
            time: { type: 'string' },
            people: { type: 'array', items: { type: 'string' } },
            location: { type: 'string' },
            content: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) throw new Error('quick_memo requires a calling agent Session')
        const header = session.requestHeader()
        if (header === undefined) throw new Error('quick_memo: no request-header route is available')

        const stream = ctx.llm.stream({
          provider: header.config.provider,
          model: header.config.model,
          messages: [
            createUserMessage({
              content: [{ type: 'text', text: PROMPT(args.transcript) }],
              source: { kind: 'quick-memo' },
            }),
          ],
          sessionId: session.id,
          purpose: 'quick-memo',
          signal: exec.signal,
        })

        const assembler = new BlockAssembler()
        for await (const chunk of stream) assembler.push(chunk)
        const text = assembler
          .blocks()
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')

        const memo = parseMemo(text)
        const cwd = session.header.cwd ?? process.cwd()
        const dir = join(cwd, 'memos')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, `${Date.now()}.json`), JSON.stringify(memo, null, 2), 'utf8')
        return memo
      },
    }),
  )
}

  
