import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { setCsrfToken } from "../../lib/api-client";
import { signOut } from "./auth-api";

/**
 * Returns a function that signs out. Whatever the server answers (even "your session already
 * ended"), the person is taken to the sign-in page and everything cached for them is forgotten,
 * so the next person on this browser never sees the previous person's data.
 */
export function useLogout(): () => void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: signOut,
    onSettled: () => {
      setCsrfToken(null);
      queryClient.removeQueries();
      navigate("/login", { replace: true });
    },
  });
  return () => mutation.mutate();
}
