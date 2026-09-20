'use client';

// ============================================================
// CreateMemberDialog
//
// Admin-only dialog to directly add a user to the team with
// Name, Email, Password, and Role (Agent / Viewer).
// The user is immediately provisioned into the admin's team.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, UserPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';

interface CreateMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function CreateMemberDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateMemberDialogProps) {
  const tRoles = useTranslations('Settings.roles');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'agent' | 'viewer'>('agent');
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setFullName('');
    setEmail('');
    setPassword('');
    setRole('agent');
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!email.trim() || !password.trim()) {
      toast.error('Email and password are required');
      return;
    }

    if (password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: fullName.trim(),
          email: email.trim(),
          password: password.trim(),
          role,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data.error || 'Failed to create team member');
        return;
      }

      toast.success(
        `User ${fullName || email} created and added to your team as ${role}!`,
      );
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      console.error('[CreateMemberDialog] error:', err);
      toast.error('Network error while creating member');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UserPlus className="size-4" />
            </div>
            <div>
              <DialogTitle>Add Team Member</DialogTitle>
              <DialogDescription>
                Create a user directly under your team. They will not be able to create their own team.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="fullName">Full Name</Label>
            <Input
              id="fullName"
              placeholder="e.g. Sarah Connor"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email Address</Label>
            <Input
              id="email"
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Temporary / Initial Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="role">Team Role</Label>
            <Select
              value={role}
              onValueChange={(val) => setRole(val as 'agent' | 'viewer')}
              disabled={submitting}
            >
              <SelectTrigger id="role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">
                  <span className="font-medium">{tRoles('agent')}</span> — Can chat with contacts, manage assigned deals
                </SelectItem>
                <SelectItem value="viewer">
                  <span className="font-medium">{tRoles('viewer')}</span> — Read-only access to assigned data
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create User'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
