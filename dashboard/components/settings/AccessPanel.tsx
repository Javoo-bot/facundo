"use client";

import { STAFF_ROLES, type StaffRole } from "@/lib/staffRoles";

/**
 * The allow list. Its own tab because it is the one section whose edits apply
 * immediately — the shared Save button is hidden here, so nothing implies these
 * changes are pending.
 */
export default function AccessPanel({
  allowedEmails,
  userEmail,
  newEmail,
  setNewEmail,
  newRole,
  setNewRole,
  addingEmail,
  removingEmail,
  changingRole,
  onAdd,
  onChangeRole,
  onRemove,
}: {
  allowedEmails: { email: string; role: StaffRole }[];
  userEmail: string;
  newEmail: string;
  setNewEmail: (value: string) => void;
  newRole: StaffRole;
  setNewRole: (role: StaffRole) => void;
  addingEmail: boolean;
  removingEmail: string | null;
  changingRole: string | null;
  onAdd: () => void;
  onChangeRole: (email: string, role: StaffRole) => void;
  onRemove: (email: string) => void;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-ink">Authorized emails</h3>
      <p className="mt-1 text-sm text-ink-soft">
        Only these Google accounts can sign in. Removing an email revokes access immediately — these changes
        save on the spot, not with the Save button.
      </p>

      <div className="mt-4 rounded-md border border-line">
        {allowedEmails.length === 0 ? (
          <p className="px-3 py-3 text-sm text-ink-soft">No authorized emails yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {allowedEmails.map(({ email, role }) => {
              const isSelf = email.toLowerCase() === userEmail.toLowerCase();
              return (
                <li key={email} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="truncate text-ink">{email}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      value={role}
                      onChange={(e) => onChangeRole(email, e.target.value as StaffRole)}
                      disabled={changingRole === email}
                      className="rounded-md border border-line-strong px-2 py-1 text-xs"
                    >
                      {STAFF_ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => onRemove(email)}
                      disabled={isSelf || removingEmail === email}
                      title={isSelf ? "You can't remove yourself" : undefined}
                      className="rounded-md border border-crit px-2.5 py-1 text-xs font-medium text-crit hover:bg-surface-2 disabled:cursor-not-allowed disabled:border-line disabled:text-ink-faint disabled:hover:bg-transparent"
                    >
                      {removingEmail === email ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="newperson@example.com"
          className="w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
        />
        <select
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as StaffRole)}
          className="shrink-0 rounded-md border border-line-strong px-2 py-1.5 text-sm"
        >
          {STAFF_ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onAdd}
          disabled={addingEmail || newEmail.trim().length === 0}
          className="shrink-0 rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
        >
          {addingEmail ? "Adding…" : "Add"}
        </button>
      </div>
    </section>
  );
}
