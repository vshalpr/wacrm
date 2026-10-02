import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";

export default function RetiredInvitationPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <MessageSquare className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">Invitation links are no longer active</CardTitle>
          <CardDescription className="text-muted-foreground">Ask your customer administrator to create your account, then sign in with the credentials they provide.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button render={<Link href="/login" />} variant="outline" className="w-full">Go to sign in</Button>
        </CardContent>
      </Card>
    </div>
  );
}
