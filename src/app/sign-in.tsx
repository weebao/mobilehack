import { useAuthActions } from '@convex-dev/auth/react';
import { useState } from 'react';
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PillButton } from '@/components/pill-button';
import { Wordmark } from '@/components/wordmark';
import { Radius, Spacing, Type, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { useShop } from '@/data/shop-store';
import { TEST_USER } from '@/data/test-user';
import { rememberAccountEmail } from '@/lib/session';

type Flow = 'signUp' | 'signIn';

function authError(error: unknown, flow: Flow) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('InvalidAccountId')) return 'No account uses that email. Create one instead.';
  if (message.includes('InvalidSecret') || message.includes('Invalid credentials')) return 'That password is not right.';
  if (message.includes('already exists')) return 'An account already uses that email. Sign in instead.';
  if (message.includes('Invalid password')) return 'Use a password of at least 8 characters.';
  return flow === 'signUp' ? "Couldn't create your account. Try again." : "Couldn't sign in. Try again.";
}

export default function SignInScreen() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { signIn } = useAuthActions();
  const { prepareTestCart } = useShop();
  const [flow, setFlow] = useState<Flow>('signUp');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy && !testBusy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const normalized = email.trim().toLowerCase();
      await signIn('password', { email: normalized, password, flow });
      await rememberAccountEmail(normalized);
    } catch (e) {
      setError(authError(e, flow));
      setBusy(false);
    }
  };

  const signInAsTestUser = async () => {
    if (busy || testBusy) return;
    setTestBusy(true);
    setError(null);
    prepareTestCart(true);
    try {
      try {
        await signIn('password', { ...TEST_USER, flow: 'signIn' });
      } catch (e) {
        if (!(e instanceof Error && e.message.includes('InvalidAccountId'))) throw e;
        await signIn('password', { ...TEST_USER, flow: 'signUp' });
      }
      await rememberAccountEmail(TEST_USER.email);
    } catch (e) {
      prepareTestCart(false);
      setError(authError(e, 'signIn'));
      setTestBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <View style={[styles.content, { paddingTop: insets.top + Spacing.xxxl }]}>
        <Wordmark hop style={styles.wordmark} />
        <Text style={styles.title}>{flow === 'signUp' ? 'Create your account' : 'Welcome back'}</Text>
        <Text style={styles.muted}>One cart for every store, and for the agents you connect to it.</Text>

        <View style={styles.form}>
          <TextInput
            testID="email"
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={Colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="next"
            style={styles.input}
          />
          <TextInput
            testID="password"
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={Colors.textTertiary}
            secureTextEntry
            autoComplete={flow === 'signUp' ? 'new-password' : 'current-password'}
            textContentType={flow === 'signUp' ? 'newPassword' : 'password'}
            returnKeyType="go"
            onSubmitEditing={submit}
            style={styles.input}
          />
          {error && <Text style={styles.muted}>{error}</Text>}
        </View>

        <PillButton
          variant="accent"
          label={busy ? 'One moment…' : flow === 'signUp' ? 'Create account' : 'Sign in'}
          disabled={!canSubmit}
          onPress={submit}
        />
        <Pressable
          accessibilityRole="button"
          disabled={busy || testBusy}
          hitSlop={8}
          onPress={() => {
            setFlow(flow === 'signUp' ? 'signIn' : 'signUp');
            setError(null);
          }}>
          {({ pressed }) => (
            <Text style={[styles.toggle, pressed && { color: Colors.text }]}>
              {flow === 'signUp' ? 'Already have an account? Sign in' : 'New to Cart? Create account'}
            </Text>
          )}
        </Pressable>
        <PillButton
          label="Sign in as test user"
          size="small"
          loading={testBusy}
          disabled={busy}
          onPress={signInAsTestUser}
          style={styles.testUser}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: Spacing.xxl, gap: Spacing.lg },
  wordmark: { marginBottom: Spacing.xl },
  title: { ...Type.title, color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  form: { gap: Spacing.md, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  input: {
    ...Type.body,
    fontSize: 16,
    color: Colors.text,
    height: 52,
    paddingHorizontal: Spacing.xl,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
  },
  toggle: { ...Type.body, color: Colors.textSecondary, textAlign: 'center' },
  testUser: { alignSelf: 'center', marginTop: Spacing.sm },
});
