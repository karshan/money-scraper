module Scrapers.Chase where

import Prelude
import Toppokki
import Toppokki.Util

import Control.Alt ((<|>))
import Control.Monad.Except (runExcept)
import Data.Argonaut (Json, decodeJson, jsonParser, (.:))
import Data.Either (Either(..), either)
import Data.Lens ((^.))
import Data.Maybe (maybe)
import Data.String.Regex (Regex, regex, test)
import Data.Traversable (traverse)
import Effect (Effect)
import Effect.Aff (Aff, Milliseconds(..), attempt, delay, effectCanceler, error, makeAff, parallel, sequential, throwError)
import Effect.Class (liftEffect)
import Effect.Console (log)
import Foreign (isNull, readString)
import Milkis (Headers)
import Milkis as Milkis
import Milkis.Impl.Node (nodeFetch)
import Types (ChaseCreds, LoginResult(..), ScrapeResult(..), State(..), password, username)
import Util (findM, fromMaybeErr, par, timeout)

import Debug.Trace (traceM)

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

-- Two factor step1 press this button. (Existence of this element is used to determine TwoFactorRequired)
requestDeliverySel = Selector "button#requestDeliveryDevices-sm"
twoFacDeviceSel = Selector "[name=identificationCodeDeliveredDevice]"
requestIdentificationSel = Selector "#requestIdentificationCode-sm"

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
     p (pure TwoFactorRequired <* wait requestDeliverySel page))

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

forever :: forall a. Aff a -> Aff Unit
forever m = do
  _ <- m
  forever m

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
  -- close browser
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
               go (TwoFactor page)
             Left err -> do
               log_ ("Aff error: " <> show err)
               go (AttemptingLogin (n - 1) page activityCardListRegex)
      go (TwoFactor page) = do
        delay (Milliseconds 1000.0)
        frame <- fromMaybeErr (error "login frame not found") =<<
          liftEffect (findM (\f -> (_ == loginIframeName) <$> name f) =<< frames page)
        waitForNavAfter (frameWaitAndClick requestDeliverySel frame) page
        log_ "next!"
        delay (Milliseconds 1000.0)
        eRadioValue <- unsafeEvaluateStringFunction """function f() {
            var frame = window.frames[0].document;
            var radios = frame.querySelectorAll('[name=identificationCodeDeliveredDevice]');
            for (var i = 0; i < radios.length; i++) {
              var label = frame.querySelector('#label-deviceoption' + radios[i].value);
              if (label && label.innerText.endsWith("gmail.com")) {
                radios[i].click();
                return "clicked";
              }
            }
            return "failed";
          }; f();
        """ page
        case runExcept (readString eRadioValue) of
             Left e -> log_ "readString failed" *> log_ (show e)
             Right radioValue -> log_ radioValue
        waitForNavAfter (frameWaitAndClick requestIdentificationSel frame) page
        forever (delay (Milliseconds 1000.0))
        pure Failure
        {-
          res = document.querySelectorAll('[name=identificationCodeDeliveredDevice]')
              <input type="radio" id="input-deviceoptionT476231062" aria-describedby="" value="T476231062" name="identificationCodeDeliveredDevice">
              <input type="radio" id="input-deviceoptionS482963975" aria-describedby="" value="S482963975" name="identificationCodeDeliveredDevice">
                           ...
          document.querySelector('#label-deviceoption' + res[2].value).innerText = "k...a@gmail.com"
          res[2].click()
          frameWaitAndClick(Sel #requestIdentificationCode-sm)

          input#otpcode_input-input-field
          input#password_input-input-field
          button#log_on_to_landing_page-sm
        -}

      go (LoggedIn cs) = Success <$> performRequests cs
