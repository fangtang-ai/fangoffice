export function knowledgeDeletionPrompt(title: string, recovering = false) {
  return {
    message: recovering ? '继续确认这次删除的结果？' : '确定删除文件及其对应知识吗？',
    detail: `${title}\n\n删除会释放该文件占用的空间，已购总容量不减少。\n但不会保留此前从该文件建立的知识，删除后不再用于后续检索和AI引用。\n\n此操作无法撤销，不会删除本机原文件；不代表物理文件已立即清除或费用已退款。`,
  }
}
