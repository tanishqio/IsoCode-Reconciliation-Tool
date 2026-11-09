import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { ErrorState } from "../../components/feedback";
import { Wordmark } from "../../components/layout/Wordmark";
import { Button, TextField } from "../../components/ui";
import { getErrorMessage, getFieldErrors, isApiError } from "../../lib/api-error";
import { ME_KEY, signIn } from "./auth-api";
import { landingPathFor, safeNextPath } from "./auth-paths";

const schema = z.object({
  email: z.string().trim().min(1, "Enter your email."),
  password: z.string().min(1, "Enter your password."),
});
type Values = z.infer<typeof schema>;

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const mutation = useMutation({
    mutationFn: (values: Values) => signIn(values.email, values.password),
    onSuccess: (user) => {
      // Start from a clean cache, so nothing from a previous person on this browser is shown.
      queryClient.removeQueries();
      queryClient.setQueryData(ME_KEY, user);
      navigate(safeNextPath(searchParams.get("next")) ?? landingPathFor(user.role), {
        replace: true,
      });
    },
    onError: (error) => {
      // The server rejected a field itself (a 422): show it next to that field.
      for (const [field, message] of Object.entries(getFieldErrors(error))) {
        if (field === "email" || field === "password") setError(field, { message });
      }
    },
  });

  const serverError = mutation.error;
  const showPanel = serverError && Object.keys(getFieldErrors(serverError)).length === 0;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <Wordmark className="-ml-2 self-start" />

      <div>
        <h1 className="text-title font-semibold tracking-tight text-ink">Sign in</h1>
        <p className="mt-0.5 text-body text-muted">Use the account your team set up for you.</p>
      </div>

      {showPanel ? (
        <ErrorState
          message={getErrorMessage(serverError)}
          requestId={isApiError(serverError) ? serverError.requestId : undefined}
        />
      ) : null}

      <form
        noValidate
        onSubmit={handleSubmit((values) => mutation.mutate(values))}
        className="flex flex-col gap-4"
      >
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
          error={errors.email?.message}
          {...register("email")}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register("password")}
        />
        <Button
          type="submit"
          variant="primary"
          className="h-9 w-full"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Signing in\u2026" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
