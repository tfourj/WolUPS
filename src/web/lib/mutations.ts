import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/** Mutation that shows a toast and refreshes the given query keys afterwards. */
export function useAction<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { invalidate?: string[][]; success?: string | ((r: TResult) => string | null) } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      const message = typeof opts.success === "function" ? opts.success(result) : opts.success;
      if (message) toast.success(message);
      for (const key of opts.invalidate ?? []) queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
}
