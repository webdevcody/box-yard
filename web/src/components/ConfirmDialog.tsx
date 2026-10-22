import { settleConfirm, useCurrentConfirm } from "../lib/confirm"
import { Modal } from "./Modal"
import { Button } from "./ui"

/** Mounted once in the app: shows whatever confirmDialog() is waiting on. */
export function ConfirmHost() {
  const req = useCurrentConfirm()
  if (!req) return null
  const answer = (ok: boolean) => settleConfirm(req.id, ok)
  return (
    <Modal
      key={req.id}
      size="sm"
      title={req.title}
      onClose={() => answer(false)}
      onSubmit={(e) => {
        e.preventDefault()
        answer(true)
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={() => answer(false)}>
            {req.cancelLabel ?? "Cancel"}
          </Button>
          <Button type="submit" variant={req.danger ? "danger" : "primary"} autoFocus>
            {req.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      {req.body && <p className="text-sm text-zinc-400">{req.body}</p>}
    </Modal>
  )
}
