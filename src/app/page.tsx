import { redirect } from 'next/navigation'
import { requirePlatformAdmin } from '@/lib/auth/platform'

export default async function RootPage() {
  let isPlatformAdmin = false
  try {
    await requirePlatformAdmin()
    isPlatformAdmin = true
  } catch {
    // Normal customer sessions do not have a platform-administrator row.
  }
  redirect(isPlatformAdmin ? '/platform/customers' : '/dashboard')
}
