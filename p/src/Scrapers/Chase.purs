module Scrapers.Chase where

import Control.Monad.Rec.Class
import Data.Argonaut
import Prelude
import Toppokki
import Types

import Control.Alt ((<|>))
import Control.Monad.Error.Class (class MonadThrow)
import Data.Array (head, filterA)
import Data.Either (Either(..), either)
import Data.Foldable (intercalate)
import Data.Lens ((^.))
import Data.Maybe (Maybe(..), maybe)
import Data.Options (Options, (:=))
import Data.String.Regex (Regex, regex, test)
import Data.Traversable (traverse)
import Effect (Effect)
import Effect.Aff (Aff, Milliseconds(..), attempt, delay, effectCanceler, error, launchAff_, makeAff, parallel, sequential, throwError)
import Effect.Class (liftEffect)
import Effect.Console (log)
import Foreign.Object (Object)
import Foreign.Object as Object
import Milkis (Headers)
import Milkis as Milkis
import Milkis.Impl.Node (nodeFetch)

-- UTIL
bool :: forall a. a -> a -> Boolean -> a
bool a _ false = a
bool _ a true = a

findM :: forall a m. Monad m => (a -> m Boolean) -> Array a -> m (Maybe a)
findM p xs =
  head <$> filterA p xs

fromMaybeErr :: forall a m e. MonadThrow e m => e -> Maybe a -> m a
fromMaybeErr e = maybe (throwError e) pure

par :: forall a. Aff a -> Aff a -> Aff a
par a b = sequential (parallel a <|> parallel b)

timeout :: forall a. Milliseconds -> Aff a -> Aff a
timeout t a = do
  either (const $ throwError (error "Timed out")) pure
    =<< par (Right <$> a) (Left <$> delay t)

-- Toppokki util
renderCookies :: Array Cookie -> String
renderCookies = intercalate "; " <<< map (\c -> c.name <> "=" <> c.value)

waitForResponse :: (Response -> Effect Boolean) -> Page -> Aff Unit
waitForResponse predicate page =
  timeout (Milliseconds 15000.0)
    (makeAff \cb -> do
      r <- responseListenerRec
              (\r response -> do
                  p <- predicate response
                  if p then do
                    removeResponseListener r page
                    cb (Right unit)
                    else
                      pure unit)
      addResponseListener r page
      pure $ effectCanceler (removeResponseListener r page))

waitForUrlRegex :: Regex -> Page -> Aff Unit
waitForUrlRegex urlRegex page =
  waitForResponse (\r -> test urlRegex <$> (reqUrl <=< request) r) page

frameWaitAndClick :: Selector -> Frame -> Aff Unit
frameWaitAndClick s frame = do
  e <- frameWaitForSelector s { visible: true } frame
  clickElement e

-- TODO remove waitForNavigation from Toppoki
-- replace with waitForNavAfter
waitForNavAfter :: Aff Unit -> Page -> Aff Unit
waitForNavAfter f page =
  par f (waitForNavigation {} page)
-- END UTIL

userAgent :: String
userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36"

loginPageUrl :: String
loginPageUrl = "https://secure05c.chase.com/web/auth/dashboard"

loginIframeSel = Selector "#logonbox"
loginIframeName = "logonbox"
signInButtonSel = Selector "#signin-button"
usernameSel = Selector "#userId-input-field"
passwordSel = Selector "#password-input-field"

-- if login failed document.querySelector('#inner-logon-error').innerText will be "Important: Your username or password doesn't match what we have on file. Try signing in again, or choose Forgot username/password for help."
logonErrorSel = Selector "#inner-logon-error"

-- URL regex used with waitForUrlRegex()
-- https://secure05c.chase.com/svc/rr/accounts/secure/v2/activity/card/list
eActivityCardListRegex = regex "/activity/card/list$" mempty

login :: Page -> ChaseCreds -> Regex -> Aff LoginResult
login page creds activityCardList = do
  -- Wait on iframe if it exists otherwise wait on page
  let wait sel p = do
        mFrame <- liftEffect (findM (\f -> (_ == loginIframeName) <$> name f) =<< frames p)
        maybe (pageWaitForSelector sel {} p)
          (\f -> frameWaitForSelector sel {} f) mFrame
  goto (URL loginPageUrl) page
  _ <- pageWaitForSelector loginIframeSel {} page
  frame <- fromMaybeErr (error "login frame not found") =<<
    liftEffect (findM (\f -> (_ == loginIframeName) <$> name f) =<< frames page)
  frameWaitAndClick usernameSel frame
  pageType (creds^.username) page
  frameWaitAndClick passwordSel frame
  pageType (creds^.password) page
  let p = parallel
  waitForNavAfter (frameWaitAndClick signInButtonSel frame) page
  sequential
    (p (pure LoginFailed <* wait logonErrorSel page) <|>
     p (pure LoginSucceeded <* waitForUrlRegex activityCardList page) <|>
     p (pure TwoFactorRequired <* wait (Selector "button#requestDeliveryDevices-sm") page))

httpPost :: Milkis.URL -> Headers -> String -> Aff Json
httpPost url headers body = do
  respText <- Milkis.text =<< Milkis.fetch nodeFetch url { method: Milkis.postMethod, body: body, headers: headers }
  either (throwError <<< error) pure $ jsonParser respText

-- FIXME preserve accountTiles data
-- Switch to genericDecodeJSON ?
performRequests :: Array Cookie -> Aff (Array Json)
performRequests cs = do
  let hdrs = (Milkis.makeHeaders {
        "User-Agent": userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "Cookie": renderCookies cs,
        "x-jpmc-csrf-token": "NONE"
      })
  resp <- httpPost
    (Milkis.URL "https://secure05c.chase.com/svc/rr/accounts/secure/v4/dashboard/tiles/list")
    hdrs
    "cache=1"
  (accountIds :: Array Int) <-
    either (throwError <<< error <<< ("decodeAccountIds: " <> _)) pure $
        traverse (_ .: "accountId") =<< (_ .: "accountTiles") =<< decodeJson resp
  liftEffect $ log (show accountIds)
  traverse
    (\accId ->
        httpPost (Milkis.URL "https://secure05c.chase.com/svc/rr/accounts/secure/v2/activity/card/list")
          hdrs
          ("accountId=" <> show accId <> "&filterTranType=ALL&statementPeriodId=ALL"))
    accountIds

log_ :: String -> Aff Unit
log_ s = liftEffect (log s)

scrape :: ChaseCreds -> Aff ScrapeResult
scrape creds = do
  activityCardListRegex <- either (throwError <<< error) pure eActivityCardListRegex
  browser <- launch { headless: false, userDataDir: "chrome-dir" }
  page <- newPage browser
  setUserAgent userAgent page
  setViewport { width: 1920, height: 1080 } page
  -- causes error ? allowDownloads "./downloads/" page
  delay (Milliseconds 1000.0)
  res <- go (AttemptingLogin 5 page activityCardListRegex)
  close browser
  pure res
    where
      go :: State -> Aff ScrapeResult
      go (AttemptingLogin 0 _ _) = pure Failure
      go (AttemptingLogin n page activityCardListRegex) = do
        r <- attempt (login page creds activityCardListRegex)
        case r of
             Right LoginSucceeded -> do
               cs <- cookies page
               go (LoggedIn cs)
             Right LoginFailed -> do
               log_ "invalid username/password"
               pure Failure
             Right TwoFactorRequired -> do
               log_ "two factor required"
               pure Failure
             Left err -> do
               log_ ("Aff error: " <> show err)
               go (AttemptingLogin (n - 1) page activityCardListRegex)
      go (LoggedIn cs) = Success <$> performRequests cs
