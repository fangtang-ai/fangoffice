import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createKnowledgeSkill, type KnowledgeChatApi } from '@genoffice/agent-core'

export function useKnowledgeChat(api: KnowledgeChatApi | undefined, onAccountChanged: () => void) {
  const skill = useMemo(() => createKnowledgeSkill(api), [api])
  const callback = useRef(onAccountChanged)
  callback.current = onAccountChanged
  const epoch = useRef(0)
  const [version, setVersion] = useState(0)
  useEffect(
    () =>
      api?.onSessionChanged(() => {
        // Invalidate asynchronous history loads before clearing the visible/model conversation.
        epoch.current += 1
        callback.current()
        setVersion(epoch.current)
      }),
    [api],
  )
  const capture = useCallback(() => {
    const expected = epoch.current
    return () => expected === epoch.current
  }, [])
  return { skill, version, capture }
}
