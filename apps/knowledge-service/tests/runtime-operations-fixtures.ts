import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import { environment } from './runtime-fixtures'

const execute = promisify(execFile)

export async function assertRuntimeConfiguration(
  directory: string,
  baseEnvironment: NodeJS.ProcessEnv,
) {
  for (const role of ['api', 'worker']) {
    const env = {
      ...baseEnvironment,
      ...environment,
      ...(role === 'api'
        ? { KNOWLEDGE_WORKER_DATABASE_URL: 'invalid-unused-worker-target' }
        : {
            KNOWLEDGE_API_DATABASE_URL: 'invalid-unused-api-target',
            KNOWLEDGE_AUTH_ISSUER: undefined,
            KNOWLEDGE_AUTH_AUDIENCE: undefined,
          }),
    }
    await expect(
      execute(process.execPath, ['check-config.mjs', role], { cwd: directory, env, timeout: 3000 }),
    ).resolves.toMatchObject({ stdout: `knowledge-${role} configuration valid\n`, stderr: '' })
    await expect(
      execute(process.execPath, ['check-config.mjs', role], {
        cwd: directory,
        env: baseEnvironment,
        timeout: 3000,
      }),
    ).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'NOT_CONFIGURED\n' })
  }
  for (const args of [[], ['api', 'worker'], [environment.KNOWLEDGE_API_DATABASE_URL]]) {
    await expect(
      execute(process.execPath, ['check-config.mjs', ...args], {
        cwd: directory,
        env: { ...baseEnvironment, ...environment },
        timeout: 3000,
      }),
    ).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'NOT_CONFIGURED\n' })
  }
  await assertEnvironmentFiles(directory, baseEnvironment)
}

async function assertEnvironmentFiles(directory: string, env: NodeJS.ProcessEnv) {
  for (const role of ['api', 'worker']) {
    const template = await readFile(join(directory, `${role}.env.example`), 'utf8')
    const names = [...template.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1])
    expect(names).toEqual([
      'KNOWLEDGE_ENVIRONMENT',
      'KNOWLEDGE_DATABASE_NAME',
      ...(role === 'api'
        ? [
            'KNOWLEDGE_API_DATABASE_ROLE',
            'KNOWLEDGE_API_DATABASE_URL',
            'KNOWLEDGE_AUTH_ISSUER',
            'KNOWLEDGE_AUTH_AUDIENCE',
            'KNOWLEDGE_AUTH_REQUIRED_SCOPES',
            'KNOWLEDGE_API_HOST',
            'KNOWLEDGE_API_PORT',
          ]
        : ['KNOWLEDGE_WORKER_DATABASE_ROLE', 'KNOWLEDGE_WORKER_DATABASE_URL']),
    ])
    expect(template).toContain('KNOWLEDGE_ENVIRONMENT=production\n')
    expect(template).toContain('KNOWLEDGE_DATABASE_NAME=\n')
    expect(template).toContain(`KNOWLEDGE_${role.toUpperCase()}_DATABASE_URL=\n`)
    await expect(
      execute(process.execPath, [`--env-file=${role}.env.example`, 'check-config.mjs', role], {
        cwd: directory,
        env,
        timeout: 3000,
      }),
    ).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'NOT_CONFIGURED\n' })
    let populated = template
    for (const [name, value] of Object.entries(environment))
      populated = populated.replace(`${name}=\n`, `${name}=${JSON.stringify(value)}\n`)
    await writeFile(join(directory, `${role}.synthetic.env`), populated)
    await expect(
      execute(process.execPath, [`--env-file=${role}.synthetic.env`, 'check-config.mjs', role], {
        cwd: directory,
        env,
        timeout: 3000,
      }),
    ).resolves.toMatchObject({ stdout: `knowledge-${role} configuration valid\n`, stderr: '' })
    await expect(
      execute(process.execPath, [`--env-file=${role}.synthetic.env`, 'check-config.mjs', role], {
        cwd: directory,
        env: { ...env, KNOWLEDGE_DATABASE_NAME: 'wrong_inherited_database' },
        timeout: 3000,
      }),
    ).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'NOT_CONFIGURED\n' })
  }
  for (const role of ['api', 'worker']) {
    const otherRole = role === 'api' ? 'worker' : 'api'
    await expect(
      execute(
        process.execPath,
        [`--env-file=${otherRole}.synthetic.env`, 'check-config.mjs', role],
        {
          cwd: directory,
          env,
          timeout: 3000,
        },
      ),
    ).rejects.toMatchObject({ code: 1, stdout: '', stderr: 'NOT_CONFIGURED\n' })
  }
  await expect(
    execute(process.execPath, ['--env-file=missing.synthetic.env', 'check-config.mjs', 'api'], {
      cwd: directory,
      env,
      timeout: 3000,
    }),
  ).rejects.toMatchObject({ stdout: '' })
}
