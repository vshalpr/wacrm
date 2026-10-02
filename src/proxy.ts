import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Signed-in users should use the application root, which dispatches
  // platform administrators to their separate control plane.
  if (user && request.nextUrl.pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    url.search = ''
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Authenticated API routes often use the service role after resolving a
  // customer id, which bypasses RLS. Fail closed here using live membership
  // and account status before any CRM handler can run. Inbound/status webhooks
  // and scheduled workers have their own trusted authentication and remain
  // available so suspended customers can still receive messages/receipts.
  const pathname = request.nextUrl.pathname
  const trustedInboundOrWorker =
    pathname.startsWith('/api/platform') ||
    pathname.startsWith('/api/whatsapp/webhook') ||
    pathname.startsWith('/api/automations/cron') ||
    pathname.startsWith('/api/flows/cron') ||
    pathname.startsWith('/api/v1')
  const customerPage = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
    .some(path => pathname === path || pathname.startsWith(`${path}/`))
  const customerApi = pathname.startsWith('/api/') && !trustedInboundOrWorker
  if (user && !trustedInboundOrWorker && (customerPage || customerApi)) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('account_id, status')
      .eq('user_id', user.id)
      .maybeSingle()
    let active = !profileError && profile?.status === 'active' && Boolean(profile.account_id)
    if (active && profile) {
      const { data: account, error: accountError } = await supabase
        .from('accounts')
        .select('status')
        .eq('id', profile.account_id)
        .maybeSingle()
      active = !accountError && account?.status === 'active'
    }
    if (!active) {
      if (customerApi) {
        return withRefreshedCookies(NextResponse.json({ error: 'Customer account is not active' }, { status: 403 }))
      }
      const url = request.nextUrl.clone()
      url.pathname = '/account-suspended'
      url.search = ''
      return withRefreshedCookies(NextResponse.redirect(url))
    }
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/platform', '/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
